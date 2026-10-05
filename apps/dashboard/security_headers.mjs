/**
 * Security response headers for the operator dashboard.
 *
 * The dashboard authenticates staff through an OAuth flow, carries a session
 * cookie, and renders operator actions. None of that was expressed to the
 * browser: there was no CSP, no HSTS, no framing control, and no referrer policy,
 * so the workspace and the logout control could be framed by any origin the
 * operator was lured to visit, and an http-first navigation was never told to
 * stay on https. This module is the single place those controls are decided.
 *
 * The policy is deliberately split by deployment shape rather than applied
 * uniformly:
 *
 * - HSTS is emitted only for an https, non-loopback origin. A loopback developer
 *   running over plain http would otherwise have their browser pinned to https
 *   for an origin that has no https listener, which bricks local development.
 * - `upgrade-insecure-requests` follows the same rule for the same reason.
 * - The development relaxation (`ws:`, `wss:`, `'unsafe-eval'`) is scoped to
 *   `is_production: false`. Next's dev server and its overlay need a websocket
 *   and evaluate bundles; production does not, so production does not get them.
 *
 * `'unsafe-inline'` in `script-src` and `style-src` is a known, accepted gap, not
 * an oversight. Next's App Router emits inline bootstrap and hydration scripts,
 * and the design system injects inline styles; a CSP that blocks them produces a
 * blank page, which is a worse outcome than the residual inline-execution risk it
 * removes. Moving to a per-response nonce is the follow-up, and it needs a
 * middleware step because a static `headers()` entry cannot mint one.
 *
 * One entry, sourced at `/:path*`, covers every route: the workspace pages, the
 * auth route handlers that redirect and set the session cookie, and the static
 * assets. A policy that applied to documents but not to `/auth/logout` would
 * leave the one route that clears a credential unprotected.
 */

/** Loopback hosts that must never receive a pinning header. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** HSTS lifetime: two years, so a forgotten pin is not a permanent one. */
const HSTS_MAX_AGE_SECONDS = 63_072_000;

/**
 * Build the dashboard's security headers.
 *
 * @param {object} options
 * @param {string} [options.public_base_url] - Configured public origin, used only
 *   to decide whether transport security applies.
 * @param {boolean} options.is_production - False enables the development-only
 *   relaxations the Next dev server needs.
 * @returns {Array<{ source: string, headers: Array<{ key: string, value: string }> }>}
 */
export function security_headers(options) {
  const is_production = options?.is_production === true;
  const secure_origin = is_https_non_loopback(options?.public_base_url);
  return [
    {
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: content_security_policy(is_production, secure_origin) },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        ...(secure_origin ? [{ key: "Strict-Transport-Security", value: hsts_value() }] : []),
      ],
    },
  ];
}

/**
 * Assemble the policy.
 *
 * `default-src 'self'` is the anchor: a directive the app never needed is not
 * listed, so a new surface cannot load a remote origin by default. `frame-ancestors`
 * duplicates `X-Frame-Options` deliberately — the header predates CSP and is the
 * only one an older browser honours.
 *
 * @param {boolean} is_production - False adds the dev-only connect and eval sources.
 * @param {boolean} secure_origin - True adds `upgrade-insecure-requests`.
 * @returns {string} A complete policy value.
 */
function content_security_policy(is_production, secure_origin) {
  const directives = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'none'"]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
    ["img-src", ["'self'", "data:"]],
    ["font-src", ["'self'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["script-src", is_production ? ["'self'", "'unsafe-inline'"] : ["'self'", "'unsafe-inline'", "'unsafe-eval'"]],
    ["connect-src", is_production ? ["'self'"] : ["'self'", "ws:", "wss:"]],
  ];
  const policy = directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
  return secure_origin ? `${policy}; upgrade-insecure-requests` : policy;
}

/** The pinning value; `includeSubDomains` because the deployment owns the origin. */
function hsts_value() {
  return `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`;
}

/**
 * Decide whether transport security applies.
 *
 * @param {string | undefined} public_base_url - Configured public origin.
 * @returns {boolean} True only for an https origin that is not loopback.
 */
function is_https_non_loopback(public_base_url) {
  if (typeof public_base_url !== "string" || public_base_url.trim() === "") return false;
  try {
    const parsed = new URL(public_base_url);
    return parsed.protocol === "https:" && !LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}
