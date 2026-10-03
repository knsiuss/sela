/**
 * Helpers every staff-auth route needs, in one place.
 *
 * Four things were duplicated across the login, callback, Calendar, and logout
 * routes, and duplication is how the two copies drift:
 *
 * - The session cookie was read by a private copy in each route, so a cookie
 *   name added to one policy would silently stop being honoured in another. The
 *   precedence now lives in one policy-ordered reader in the auth boundary; both
 *   the route reader and the Server Component reader delegate to it.
 * - `status_for` / `safe_message` were re-typed per route, which is how a route
 *   ends up surfacing a provider's own wording.
 * - Post-credential redirects were built from `url.origin`, i.e. from the
 *   request's `Host` header. A freshly issued session cookie was then placed in
 *   a `Location` that pointed wherever the caller named. The redirect target is
 *   configuration (`STAFF_AUTH_PUBLIC_BASE_URL`), never request input.
 * - String shape alone cannot decide whether a path stays same-origin: WHATWG
 *   normalizes backslashes to slashes, so `/\evil.example` parses as an
 *   authority. The resolved origin is therefore compared, not the input string.
 */

import {
  OAuthFlowError,
  read_session_cookie_header,
} from "appointment-agent/dist/src/enterprise/oauth/index.js";
import type { StaffAuthRuntime } from "./runtime";

/**
 * Extract the session cookie from a `Cookie` request header.
 *
 * @param parts - Resolved runtime supplying the cookie policy.
 * @param header - Raw `Cookie` request header.
 * @returns The cookie value, or undefined when no session cookie is present.
 * @throws OAuthFlowError when the cookie policy is inconsistent.
 */
export function read_session_cookie(parts: StaffAuthRuntime, header: string | null): string | undefined {
  return read_session_cookie_header(header, parts.config.cookie);
}

/**
 * Map a caught error to a sanitized status.
 *
 * @param error - Error thrown by the flow or the composition root.
 * @returns The domain status, or 503 for anything unexpected.
 */
export function status_for(error: unknown): number {
  return error instanceof OAuthFlowError ? error.status() : 503;
}

/**
 * Render a sanitized failure body without echoing a provider response.
 *
 * @param error - Error thrown by the flow or the composition root.
 * @returns A closed vocabulary code.
 */
export function safe_message(error: unknown): string {
  return error instanceof OAuthFlowError ? error.code : "staff-auth-unavailable";
}

/**
 * Build a same-origin `Location` from the configured public base URL.
 *
 * The configured origin is the only acceptable redirect target after a
 * credential has just been issued or cleared: the request's `Host` header is
 * caller-influenceable, so deriving it here would let a poisoned header steer a
 * browser carrying a session cookie to an attacker origin.
 *
 * The shape check rejects the obvious absolute and traversing forms, and the
 * resolved origin is then compared against the configured one. Comparing the
 * result rather than the string is what closes the backslash forms
 * (`/\host`, `/\/host`), which pass a "starts with `/`" test and still parse to
 * a foreign authority.
 *
 * @param parts - Resolved runtime supplying the configured public origin.
 * @param path - Allow-listed relative path to return to.
 * @returns Absolute URL on the configured origin.
 * @throws OAuthFlowError when the path is absolute, traverses, or resolves off
 * the configured origin.
 */
export function workspace_redirect(parts: StaffAuthRuntime, path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
    throw new OAuthFlowError("oauth_return_path_invalid");
  }
  let resolved: URL;
  try {
    resolved = new URL(path, parts.config.public_base_url);
  } catch {
    throw new OAuthFlowError("oauth_return_path_invalid");
  }
  if (resolved.origin !== new URL(parts.config.public_base_url).origin) {
    throw new OAuthFlowError("oauth_return_path_invalid");
  }
  return resolved.toString();
}
