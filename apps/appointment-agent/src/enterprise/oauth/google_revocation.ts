/**
 * Google-side revocation for the stored Calendar grants.
 *
 * The grant store deliberately holds no Google client credentials, so it cannot
 * ask the provider to invalidate a refresh token by itself. It takes the revoker
 * as an injected port instead, and this module is the production implementation
 * of that port.
 *
 * The request carries the token alone. Google's revocation endpoint takes a
 * single `token` form field, so a client secret here would only widen the module's
 * secret surface for no effect. The token is never logged, audited, or retained:
 * it lives in the argument and in the request body for the duration of the call.
 *
 * This module deliberately has no provider-package import, for the same reason
 * `code_exchangers.ts` does not: the staff-auth modules are consumed by the
 * dashboard's bundler, which cannot follow the Calendar package's NodeNext
 * source specifiers. `packages/mcp-gcal` holds the equivalent call for the
 * Calendar client's own credential lifecycle; collapsing the two into one
 * implementation is a known follow-up, not something to solve by widening this
 * module's dependency graph.
 */

import type { OAuthFetch } from "./transport_types.js";

/** Google's OAuth 2.0 revocation endpoint. */
export const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TOKEN_CHARS = 4096;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

/** Options for the injected revocation call. */
export interface GoogleRevokerOptions {
  /** Replaceable transport so a test never reaches the network. */
  fetch?: OAuthFetch;
  /** Upstream request timeout in milliseconds. */
  request_timeout_ms?: number;
}

/**
 * Build the `revoke_upstream` implementation for a grant store.
 *
 * The transport is resolved when the revoker is called rather than when it is
 * built, so the composition root does not have to capture a global it may later
 * replace, and an unavailable transport is reported at the moment a revoke is
 * actually attempted rather than at startup.
 *
 * @param options - Optional transport and timeout overrides.
 * @returns A revoker that asks Google to invalidate one refresh token.
 */
export function google_grant_revoker(
  options: GoogleRevokerOptions = {},
): (refresh_token: string) => Promise<void> {
  return async (refresh_token: string): Promise<void> => {
    const do_fetch = options.fetch ?? globalThis.fetch;
    if (typeof do_fetch !== "function") throw new TypeError("google-revocation-fetch-unavailable");
    const response = await post_revoke(do_fetch, require_token(refresh_token), options.request_timeout_ms);
    // Google answers success with 200 and an empty body, so only the status is
    // read. The failure carries the status and never the token.
    if (!response.ok) throw new Error(`google-revocation-failed:${response.status}`);
  };
}

/** POST one token to Google's revocation endpoint. */
async function post_revoke(
  do_fetch: OAuthFetch,
  token: string,
  timeout_ms: number | undefined,
): Promise<Response> {
  const body = new URLSearchParams({ token });
  try {
    return await do_fetch(GOOGLE_REVOCATION_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(timeout_ms ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    // A transport failure is indistinguishable from a refusal for the caller's
    // purposes, and neither may echo the token.
    throw new Error("google-revocation-failed:transport");
  }
}

/** Require a token-shaped value without echoing it into a failure message. */
function require_token(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOKEN_CHARS || !TOKEN_PATTERN.test(value)) {
    throw new Error("google-revocation-failed:invalid-token");
  }
  return value;
}
