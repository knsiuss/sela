/**
 * Revoke the current staff session and clear its cookie.
 *
 * POST only, so a third-party page cannot log an operator out with a top-level
 * GET, and the origin check keeps a cross-site form post from reaching it.
 */

import { runtime, revoke_session } from "../runtime";

/**
 * Revoke the session addressed by the request cookie.
 *
 * @param request - Incoming logout request.
 * @returns A redirect to the login page with the cookie cleared.
 */
export async function POST(request: Request): Promise<Response> {
  const cookie_value = read_session_cookie(request.headers.get("cookie"));
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  if (origin !== null && origin !== url.origin) return new Response("cross_origin_logout_refused", { status: 403 });
  try {
    const parts = runtime();
    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL("/auth/login", url.origin).toString(),
        "Set-Cookie": await revoke_session(parts, cookie_value),
      },
    });
  } catch {
    // Even without a resolvable runtime the browser must stop holding the
    // cookie, so the response clears it with the documented default attributes.
    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL("/auth/login", url.origin).toString(),
        "Set-Cookie": "__Host-sel_session=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure",
      },
    });
  }
}

/**
 * Extract the session cookie from a `Cookie` header.
 *
 * @param header - Raw `Cookie` request header.
 * @returns The cookie value, or undefined when absent.
 */
function read_session_cookie(header: string | null): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "__Host-sel_session" || name === "sel_session") return rest.join("=");
  }
  return undefined;
}