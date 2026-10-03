/**
 * Google authorization request construction for staff sign-in and Calendar consent.
 *
 * This is the *request* half of Google's authorization-code flow and belongs to
 * the identity layer rather than to the Calendar client, which keeps the
 * authorization-code exchange reachable without pulling a provider package into
 * every consumer of the staff-auth modules.
 *
 * Endpoint values come from Google's published OAuth 2.0 server metadata
 * (`https://accounts.google.com/.well-known/oauth-authorization-server`), which
 * declares `code_challenge_methods_supported: ["plain", "S256"]` and
 * `token_endpoint_auth_methods_supported: ["client_secret_post",
 * "client_secret_basic"]`. PKCE is therefore sent as required; the client secret
 * still travels because a Web application client authenticates with it.
 */

import { OAuthFlowError } from "./oauth_error.js";

/** Google OAuth 2.0 authorization endpoint. */
export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

const MAX_PARAM_CHARS = 2048;
const MAX_SCOPE_CHARS = 1024;
const MAX_SCOPES = 16;
const MAX_IDP_CHARS = 2048;
// Every real Google scope is a URI such as
// `https://www.googleapis.com/auth/calendar.events`, so `:` is part of the shape.
const SCOPE_PATTERN = /^[A-Za-z][A-Za-z0-9._~:/-]{0,127}$/;
const OPAQUE_PATTERN = /^[A-Za-z0-9._~+/=-]{1,4096}$/;
const BASE64URL_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Consent prompt behaviour. */
export type GoogleConsentPrompt = "none" | "consent" | "select_account";

/** Everything needed to render one consent redirect. */
export interface GoogleConsentRequest {
  client_id: string;
  redirect_uri: string;
  scopes: readonly string[];
  state: string;
  code_challenge: string;
  nonce: string;
  /** Request offline access so Google issues a durable refresh token. */
  offline_access?: boolean;
  /** Omit to let Google reuse an existing grant without re-prompting. */
  prompt?: GoogleConsentPrompt;
  login_hint?: string;
}

/**
 * Build the Google consent redirect for an authorization-code request.
 *
 * @param request - Client, redirect, scopes, state, PKCE challenge, and nonce.
 * @returns Absolute consent URL; never contains a secret.
 * @throws OAuthFlowError when any parameter is malformed, so an invalid request
 * fails before a redirect leaves the process.
 */
export function build_google_consent_url(request: GoogleConsentRequest): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", require_opaque(request?.client_id, "client_id"));
  url.searchParams.set("redirect_uri", require_redirect_uri(request?.redirect_uri));
  url.searchParams.set("scope", require_scopes(request?.scopes));
  url.searchParams.set("state", require_opaque(request?.state, "state"));
  url.searchParams.set("code_challenge", require_code_challenge(request?.code_challenge));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", require_opaque(request?.nonce, "nonce"));
  if (request.offline_access === true) url.searchParams.set("access_type", "offline");
  if (request.prompt !== undefined) url.searchParams.set("prompt", require_prompt(request.prompt));
  if (request.login_hint !== undefined) {
    url.searchParams.set("login_hint", require_opaque(request.login_hint, "login_hint"));
  }
  return url.toString();
}

/**
 * Require an absolute https redirect URI, or an http loopback URI.
 *
 * Google permits `http` only for loopback development redirect URIs, so an http
 * redirect to a routable host is refused rather than forwarded.
 *
 * @param value - Candidate redirect URI.
 * @returns The validated absolute redirect URI.
 * @throws OAuthFlowError when the URI is not an acceptable redirect target.
 */
function require_redirect_uri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const is_https = parsed.protocol === "https:";
  const is_loopback = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" || (!is_https && !is_loopback)) {
    throw new OAuthFlowError("oauth_redirect_not_allowed");
  }
  return parsed.toString();
}

/**
 * Require an opaque OAuth value without echoing it into a failure message.
 *
 * @param value - Untrusted client, state, nonce, or hint value.
 * @param field_name - Field name reported in the failure code only.
 * @returns The validated value.
 * @throws OAuthFlowError when the value is empty, oversized, or malformed.
 */
function require_opaque(value: string, field_name: string): string {
  if (typeof value !== "string" || value.length > MAX_PARAM_CHARS || !OPAQUE_PATTERN.test(value)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}

/** Require a bounded, de-duplicated scope list joined by single spaces. */
function require_scopes(scopes: readonly string[]): string {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > MAX_SCOPES) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const normalized = scopes.map((scope) => {
    if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
    return scope;
  });
  return [...new Set(normalized)].join(" ").slice(0, MAX_SCOPE_CHARS);
}

/** Require a base64url SHA-256 code challenge, which is always 43 characters. */
function require_code_challenge(value: string): string {
  if (typeof value !== "string" || !BASE64URL_SHA256_PATTERN.test(value)) {
    throw new OAuthFlowError("oauth_pkce_invalid");
  }
  return value;
}

/** Require one of the three prompt values Google documents. */
function require_prompt(value: string): GoogleConsentPrompt {
  if (value !== "none" && value !== "consent" && value !== "select_account") {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}

/** Exported for the endpoint assertions in the authorization-code tests. */
export const GOOGLE_MAX_IDP_CHARS = MAX_IDP_CHARS;