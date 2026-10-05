/**
 * Start a staff login by redirecting to the chosen identity provider.
 *
 * The handler accepts only an allow-listed provider and a `return_path` that the
 * flow re-validates; anything else is refused before a redirect is produced, so
 * this route cannot be used as an open redirector.
 *
 * It is also the entry point an anonymous caller can hammer, so the admission key
 * is derived here and spent inside `start_login`. The derivation lives at the
 * edge because only the edge can see the request.
 */

import { DEFAULT_RETURN_PATHS, runtime, start_login } from "../runtime";
import { safe_message, status_for } from "../route_helpers";
import { source_bucket_key } from "../client_address";

/** Providers a login request may name. */
const PROVIDERS: readonly ("supabase" | "google")[] = ["supabase", "google"];

/**
 * Redirect to the provider's authorize endpoint.
 *
 * @param request - Incoming request; its query and client address are read.
 * @returns A 302 to the IdP, 429 when the source is throttled, or a sanitized
 * error status.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const idp = url.searchParams.get("idp") ?? "";
  const return_path = url.searchParams.get("return_path") ?? DEFAULT_RETURN_PATHS[0] ?? "/actions";
  if (!PROVIDERS.includes(idp as "supabase")) return new Response("unsupported_identity_provider", { status: 400 });
  try {
    const parts = runtime();
    const { url: destination } = await start_login(
      parts,
      idp as "supabase",
      return_path,
      source_bucket_key(request, parts.config.trusted_proxy_hops),
    );
    return Response.redirect(destination, 302);
  } catch (error) {
    return new Response(safe_message(error), { status: status_for(error) });
  }
}
