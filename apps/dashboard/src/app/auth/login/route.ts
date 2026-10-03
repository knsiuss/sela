/**
 * Start a staff login by redirecting to the chosen identity provider.
 *
 * The handler accepts only an allow-listed provider and a `return_path` that the
 * flow re-validates; anything else is refused before a redirect is produced, so
 * this route cannot be used as an open redirector.
 */

import { OAuthFlowError } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import { DEFAULT_RETURN_PATHS, runtime, start_login } from "../runtime";

/** Providers a login request may name. */
const PROVIDERS: readonly ("supabase" | "google")[] = ["supabase", "google"];

/**
 * Redirect to the provider's authorize endpoint.
 *
 * @param request - Incoming request; only its query is read.
 * @returns A 302 to the IdP, or a sanitized error status.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const idp = url.searchParams.get("idp") ?? "";
  const return_path = url.searchParams.get("return_path") ?? DEFAULT_RETURN_PATHS[0] ?? "/actions";
  if (!PROVIDERS.includes(idp as "supabase")) return new Response("unsupported_identity_provider", { status: 400 });
  try {
    const parts = runtime();
    const { url: destination } = await start_login(parts, idp as "supabase", return_path);
    return Response.redirect(destination, 302);
  } catch (error) {
    return new Response(safe_message(error), { status: status_for(error) });
  }
}

/** Map a caught error to a sanitized status. */
function status_for(error: unknown): number {
  return error instanceof OAuthFlowError ? error.status() : 503;
}

/** Render a sanitized failure body without echoing a provider response. */
function safe_message(error: unknown): string {
  return error instanceof OAuthFlowError ? error.code : "staff-auth-unavailable";
}