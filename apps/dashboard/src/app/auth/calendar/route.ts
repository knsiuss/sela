/**
 * Start Google Calendar consent for a tenant the operator already belongs to.
 *
 * Requires a live session: the tenant is read from the session principal and the
 * flow refuses a tenant the principal has no membership in, so a staff member
 * cannot bind their own Google account to someone else's tenant.
 */

import { OAuthFlowError } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import { principal_from_cookie, runtime, start_calendar_consent } from "../runtime";

/**
 * Redirect to Google's consent screen for the requested tenant.
 *
 * @param request - Incoming request carrying the session cookie and tenant.
 * @returns A 302 to Google, or a sanitized error status.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tenant_id = url.searchParams.get("tenant_id") ?? "";
  try {
    const parts = runtime();
    const principal = await principal_from_cookie(parts, read_session_cookie(request.headers.get("cookie")));
    const { url: destination } = await start_calendar_consent(parts, principal, tenant_id);
    return Response.redirect(destination, 302);
  } catch (error) {
    return new Response(safe_message(error), { status: status_for(error) });
  }
}

/**
 * Extract the session cookie from a `Cookie` header.
 *
 * @param header - Raw `Cookie` request header.
 * @returns The cookie value, or undefined when absent.
 */
export function read_session_cookie(header: string | null): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "__Host-sel_session" || name === "sel_session") return rest.join("=");
  }
  return undefined;
}

/** Map a caught error to a sanitized status. */
function status_for(error: unknown): number {
  return error instanceof OAuthFlowError ? error.status() : 503;
}

/** Render a sanitized failure body without echoing a provider response. */
function safe_message(error: unknown): string {
  return error instanceof OAuthFlowError ? error.code : "staff-auth-unavailable";
}