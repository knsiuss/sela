/**
 * Start Google Calendar consent for a tenant the operator already belongs to.
 *
 * Requires a live session: the tenant is read from the session principal and the
 * flow refuses a tenant the principal has no membership in, so a staff member
 * cannot bind their own Google account to someone else's tenant.
 *
 * The same admission control as the login route applies here, because a consent
 * request mints state exactly as a login does and is equally cheap to repeat.
 */

import { principal_from_cookie, runtime, start_calendar_consent } from "../runtime";
import { read_session_cookie, safe_message, status_for } from "../route_helpers";
import { source_bucket_key } from "../client_address";

/**
 * Redirect to Google's consent screen for the requested tenant.
 *
 * @param request - Incoming request carrying the session cookie and tenant.
 * @returns A 302 to Google, 429 when the source is throttled, or a sanitized
 * error status.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tenant_id = url.searchParams.get("tenant_id") ?? "";
  try {
    const parts = runtime();
    const principal = await principal_from_cookie(parts, read_session_cookie(parts, request.headers.get("cookie")));
    const { url: destination } = await start_calendar_consent(
      parts,
      principal,
      tenant_id,
      source_bucket_key(request, parts.config.trusted_proxy_hops),
    );
    return Response.redirect(destination, 302);
  } catch (error) {
    return new Response(safe_message(error), { status: status_for(error) });
  }
}
