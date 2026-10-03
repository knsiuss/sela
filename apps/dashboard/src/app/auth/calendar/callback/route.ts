/**
 * Complete Google Calendar consent and store the encrypted refresh token.
 *
 * The tenant comes from the state record, not from the callback query, and is
 * re-checked against the session principal, so the tenant-to-Google-account
 * mapping can only ever be created by a member of that tenant.
 */

import { OAuthFlowError } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import { finish_calendar_consent, principal_from_cookie, runtime } from "../../runtime";
import { read_session_cookie } from "../route";

/**
 * Store the granted refresh token for the bound tenant.
 *
 * @param request - Incoming callback request carrying the session cookie.
 * @returns A redirect into the workspace, or a sanitized error status.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    const parts = runtime();
    const principal = await principal_from_cookie(parts, read_session_cookie(request.headers.get("cookie")));
    const result = await finish_calendar_consent(parts, principal, read_callback_params(url));
    return new Response(null, {
      status: 302,
      headers: { Location: new URL(`/actions?calendar=${encodeURIComponent(result.tenant_id)}`, url.origin).toString() },
    });
  } catch (error) {
    return new Response(safe_message(error), { status: status_for(error) });
  }
}

/**
 * Copy only the callback parameters the flow is allowed to read.
 *
 * @param url - Callback URL.
 * @returns The parameters passed to the flow.
 */
function read_callback_params(url: URL): { code?: string; state?: string; error?: string } {
  const params: { code?: string; state?: string; error?: string } = {};
  for (const field of ["code", "state", "error"] as const) {
    const value = url.searchParams.get(field);
    if (value !== null) params[field] = value;
  }
  return params;
}

/** Map a caught error to a sanitized status. */
function status_for(error: unknown): number {
  return error instanceof OAuthFlowError ? error.status() : 503;
}

/** Render a sanitized failure body without echoing a provider response. */
function safe_message(error: unknown): string {
  return error instanceof OAuthFlowError ? error.code : "staff-auth-unavailable";
}