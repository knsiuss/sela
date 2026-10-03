/**
 * Read the staff session from the request cookie.
 *
 * This is the only place the dashboard turns an HTTP request into a principal.
 * It never falls back: an absent, malformed, expired, or revoked cookie yields
 * `null` (or a thrown `OAuthFlowError`), never a synthetic principal. The
 * previous implementation resolved one with `has_mfa: true`, which is exactly the
 * bypass this module exists to remove.
 */

import { cookies } from "next/headers";
import { OAuthFlowError, select_session_cookie } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import type { AuthenticatedPrincipal } from "appointment-agent/dist/src/enterprise/authorization.js";
import { principal_from_cookie, runtime, type StaffAuthRuntime } from "./runtime";

/**
 * Resolve the current request's principal, or null when unauthenticated.
 *
 * A configuration problem is reported as null too, so an unconfigured
 * deployment refuses the workspace rather than rendering it.
 *
 * @returns The session-backed principal, or null.
 */
export async function optional_session_principal(): Promise<AuthenticatedPrincipal | null> {
  try {
    const parts = runtime();
    return await principal_from_cookie(parts, await read_session_cookie(parts));
  } catch {
    return null;
  }
}

/**
 * Resolve the current request's principal or fail closed.
 *
 * @returns The session-backed principal.
 * @throws OAuthFlowError when there is no usable session.
 */
export async function require_session_principal(): Promise<AuthenticatedPrincipal> {
  const principal = await optional_session_principal();
  if (principal === null) throw new OAuthFlowError("oauth_session_unavailable");
  return principal;
}

/**
 * Read the raw session cookie value from the incoming request.
 *
 * Precedence comes from the cookie policy in the shared reader rather than from
 * the cookie jar's order, so this surface and the route handlers resolve the
 * same session when a browser sends both names.
 *
 * @param parts - Resolved runtime supplying the cookie policy.
 * @returns The cookie value, or undefined when no session cookie is present.
 */
export async function read_session_cookie(parts: StaffAuthRuntime): Promise<string | undefined> {
  const jar = await cookies();
  return select_session_cookie(parts.config.cookie, (name) => jar.get(name)?.value);
}
