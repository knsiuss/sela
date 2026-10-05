/**
 * One sanitized failure type for every OAuth boundary in the agent.
 *
 * Codes are stable strings safe to log, count in metrics, and translate into an
 * HTTP status. Messages never carry a token, authorization code, state value,
 * nonce, PKCE verifier, email address, or tenant credential, because these
 * errors cross a trust boundary into logs and into a browser redirect.
 */

/** Fail-closed OAuth codes grouped by the control they belong to. */
export type OAuthFlowErrorCode =
  | "oauth_configuration_invalid"
  | "oauth_state_missing"
  | "oauth_state_malformed"
  | "oauth_state_unknown"
  | "oauth_state_expired"
  | "oauth_state_replayed"
  | "oauth_state_capacity"
  | "oauth_source_rate_limited"
  | "oauth_redirect_not_allowed"
  | "oauth_return_path_invalid"
  | "oauth_pkce_invalid"
  | "oauth_nonce_mismatch"
  | "oauth_tenant_mismatch"
  | "oauth_idp_unknown"
  | "oauth_token_exchange_failed"
  | "oauth_identity_unverified"
  | "oauth_membership_unresolved"
  | "oauth_session_unavailable";

/** HTTP status for each code, so route handlers never re-derive the mapping. */
const STATUS_BY_CODE: Readonly<Record<OAuthFlowErrorCode, number>> = Object.freeze({
  oauth_configuration_invalid: 503,
  oauth_state_missing: 400,
  oauth_state_malformed: 400,
  oauth_state_unknown: 400,
  oauth_state_expired: 400,
  oauth_state_replayed: 400,
  oauth_state_capacity: 503,
  // Retryable by construction: the bucket refills, so the caller is told to come
  // back rather than that the service is broken. Answering 503 here would train
  // an operator to retry a throttle as if it were an outage.
  oauth_source_rate_limited: 429,
  oauth_redirect_not_allowed: 400,
  oauth_return_path_invalid: 400,
  oauth_pkce_invalid: 400,
  oauth_nonce_mismatch: 400,
  oauth_tenant_mismatch: 403,
  oauth_idp_unknown: 400,
  oauth_token_exchange_failed: 502,
  oauth_identity_unverified: 401,
  oauth_membership_unresolved: 403,
  oauth_session_unavailable: 401,
});

/** Sanitized OAuth failure carrying only a stable code. */
export class OAuthFlowError extends Error {
  /** Stable machine-readable code. */
  readonly code: OAuthFlowErrorCode;

  /** Create a sanitized OAuth failure. */
  constructor(code: OAuthFlowErrorCode) {
    super(`oauth-flow-failed: ${code}`);
    this.name = "OAuthFlowError";
    this.code = code;
  }

  /**
   * HTTP status for this failure.
   *
   * @returns The mapped status; unknown codes fail closed at 400.
   */
  status(): number {
    return STATUS_BY_CODE[this.code] ?? 400;
  }
}

/**
 * Map an unknown thrown value to a sanitized OAuth code.
 *
 * Provider and crypto errors are collapsed rather than forwarded so a provider
 * response body or a stack trace can never reach a client or a log line.
 *
 * @param error - Caught value from an exchange, verifier, or cipher.
 * @param fallback - Code to report when the cause cannot be classified.
 * @returns A sanitized OAuth error safe to rethrow.
 */
export function as_oauth_error(error: unknown, fallback: OAuthFlowErrorCode): OAuthFlowError {
  if (error instanceof OAuthFlowError) return error;
  return new OAuthFlowError(fallback);
}