/**
 * Helpers every staff-auth route needs, in one place.
 *
 * Three things were duplicated across the login, callback, Calendar, and logout
 * routes, and duplication is how the two copies drift:
 *
 * - The session cookie was read by a private copy in each route, so a cookie
 *   name added to one policy would silently stop being honoured in another.
 * - `status_for` / `safe_message` were re-typed per route, which is how a route
 *   ends up surfacing a provider's own wording.
 * - Post-credential redirects were built from `url.origin`, i.e. from the
 *   request's `Host` header. A freshly issued session cookie was then placed in
 *   a `Location` that pointed wherever the caller named. The redirect target is
 *   configuration (`STAFF_AUTH_PUBLIC_BASE_URL`), never request input.
 */

import { OAuthFlowError } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import type { StaffAuthRuntime } from "./runtime";

/** Cookie names the policy can produce; `__Host-` when the cookie is Secure. */
const COOKIE_NAMES: readonly string[] = ["__Host-sel_session", "sel_session"];

/**
 * Extract the session cookie from a `Cookie` request header.
 *
 * @param header - Raw `Cookie` request header.
 * @returns The cookie value, or undefined when no session cookie is present.
 */
export function read_session_cookie(header: string | null): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === undefined) continue;
    if (COOKIE_NAMES.includes(name)) return rest.join("=");
  }
  return undefined;
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
 * @param parts - Resolved runtime supplying the configured public origin.
 * @param path - Allow-listed relative path to return to.
 * @returns Absolute URL on the configured origin.
 * @throws OAuthFlowError when the path is absolute or traverses.
 */
export function workspace_redirect(parts: StaffAuthRuntime, path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
    throw new OAuthFlowError("oauth_return_path_invalid");
  }
  return new URL(path, parts.config.public_base_url).toString();
}
