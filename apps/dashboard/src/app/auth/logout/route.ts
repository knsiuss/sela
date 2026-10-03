/**
 * Revoke the current staff session and clear its cookie.
 *
 * POST only, so a third-party page cannot log an operator out with a top-level
 * GET, and the origin check keeps a cross-site form post from reaching it.
 */

import { runtime, revoke_session } from "../runtime";
import { read_session_cookie, workspace_redirect } from "../route_helpers";

/** Landing path after a logout, on the configured public origin. */
const LOGIN_PATH = "/auth/login";

/**
 * Revoke the session addressed by the request cookie.
 *
 * @param request - Incoming logout request.
 * @returns A redirect to the login page with the cookie cleared.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  if (origin !== null && origin !== url.origin) return new Response("cross_origin_logout_refused", { status: 403 });
  try {
    const parts = runtime();
    return new Response(null, {
      status: 302,
      headers: {
        Location: workspace_redirect(parts, LOGIN_PATH),
        "Set-Cookie": await revoke_session(parts, read_session_cookie(parts, request.headers.get("cookie"))),
      },
    });
  } catch {
    // Even without a resolvable runtime the browser must stop holding the
    // cookie, so the response clears it with the documented default attributes.
    // The Location stays relative in this branch: the configured origin is
    // exactly what cannot be read here, and the request origin is never
    // trusted in its place.
    return new Response(null, {
      status: 302,
      headers: {
        Location: LOGIN_PATH,
        "Set-Cookie": "__Host-sel_session=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure",
      },
    });
  }
}
