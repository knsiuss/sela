/**
 * Google token revocation for the Calendar client's credential lifecycle.
 *
 * Revocation belongs here rather than in the staff-auth modules because the
 * Calendar client is the credential's consumer: revoking a refresh token
 * invalidates the access tokens derived from it, which is what makes a Google-side
 * revoke the durable control after a suspected leak (runbook RB-06).
 *
 * The authorization-code *request* and *exchange* deliberately live in
 * `appointment-agent/.../oauth`, next to the login flow that drives them, so the
 * staff-auth modules stay free of a provider-package import.
 */

import { GoogleOAuthError, type OAuthFetch } from "./oauth.js";

/** Google OAuth 2.0 revocation endpoint. */
export const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_TOKEN_CHARS = 4096;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

/** Input for revoking one access or refresh token at Google. */
export interface GoogleRevocationInput {
  token: string;
  client_id: string;
  client_secret: string;
  fetch?: OAuthFetch;
  request_timeout_ms?: number;
}

/**
 * Revoke an access or refresh token at Google.
 *
 * @param input - Token to revoke plus client credentials.
 * @returns Nothing once Google has accepted the revocation.
 * @throws GoogleOAuthError for an invalid token, a transport failure, or an
 * upstream rejection. The message never contains the token or the secret.
 */
export async function revoke_google_token(input: GoogleRevocationInput): Promise<void> {
  const token = require_token(input?.token);
  const body = new URLSearchParams({ token });
  const fetch_implementation = input.fetch ?? globalThis.fetch;
  if (typeof fetch_implementation !== "function") {
    throw new GoogleOAuthError("configuration_error", "no fetch implementation is available");
  }
  let response: Response;
  try {
    response = await fetch_implementation(GOOGLE_REVOCATION_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(input.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (is_timeout_error(error)) throw new GoogleOAuthError("request_timeout", "Google revocation request timed out");
    throw new GoogleOAuthError("request_failed", "Google revocation request failed before a response was received");
  }
  // Google answers success with 200 and an empty body, so only the status is read.
  if (!response.ok) {
    throw new GoogleOAuthError(
      "upstream_error",
      `Google revocation request failed with status ${response.status}`,
      response.status,
    );
  }
}

/** Require a token-shaped value without echoing it into a failure message. */
function require_token(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOKEN_CHARS || !TOKEN_PATTERN.test(value)) {
    throw new GoogleOAuthError("configuration_error", "token is not a valid OAuth token");
  }
  return value;
}

function is_timeout_error(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const named = error as { name?: unknown };
  return named.name === "AbortError" || named.name === "TimeoutError";
}