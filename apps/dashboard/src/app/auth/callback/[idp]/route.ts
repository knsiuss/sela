/**
 * Complete a staff login from the identity provider's callback.
 *
 * The response sets the session cookie and redirects to the return path that was
 * bound into the state record. On any failure it returns a status instead: no
 * cookie is set, no principal is created, and the failure body is a stable code,
 * so a callback that fails validation cannot leave a usable session behind.
 */

import { OAuthFlowError } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import { finish_login, new_device_id, runtime } from "../../runtime";

/** Providers a callback may name; matches the login route's vocabulary. */
const PROVIDERS: readonly ("supabase" | "google")[] = ["supabase", "google"];

/**
 * Finish the authorization-code exchange and establish the session.
 *
 * The redirect is built explicitly rather than with `Response.redirect`, whose
 * headers are immutable and therefore cannot carry `Set-Cookie`.
 *
 * @param request - Incoming callback request.
 * @param context - Route context supplying the provider segment.
 * @returns A redirect into the workspace carrying the session cookie.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ idp: string }> },
): Promise<Response> {
  const { idp } = await context.params;
  if (!PROVIDERS.includes(idp as "supabase")) return new Response("unsupported_identity_provider", { status: 400 });
  const url = new URL(request.url);
  try {
    const parts = runtime();
    const result = await finish_login(parts, idp as "supabase", read_callback_params(url), new_device_id());
    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL(result.return_path, url.origin).toString(),
        "Set-Cookie": result.cookie,
      },
    });
  } catch (error) {
    return new Response(safe_message(error), { status: status_for(error) });
  }
}

/**
 * Copy only the callback parameters the flow is allowed to read.
 *
 * `error_description` is deliberately not copied: the flow must not surface a
 * provider's own wording, and not reading it is what guarantees that.
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