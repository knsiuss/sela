/**
 * Redirect URI allow-list and return-path validation.
 *
 * Two separate controls live here because the two inputs have different
 * trust levels:
 *
 * - `redirect_uri` is deployment configuration. It is matched by exact string
 *   equality against an allow-list; the request never supplies it, so a
 *   reflected value is impossible by construction.
 * - `return_path` is browser-supplied. It must be a *relative* path, so it can
 *   never become an absolute URL, an authority, or a protocol-relative
 *   reference, and it must additionally appear in the configured allow-list.
 */

import { OAuthFlowError } from "./oauth_error.js";

const MAX_REDIRECTS = 8;
const MAX_URI_CHARS = 2048;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RETURN_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9/_-]{0,127}$/;

/**
 * Validate and normalize one deployment-configured redirect URI.
 *
 * HTTPS is required except for an http loopback address, which is the only
 * shape both supported IdPs accept for local development. Embedded credentials,
 * fragments, and query strings are refused so a redirect URI cannot smuggle
 * state into a query or impersonate an authority.
 *
 * @param value - Candidate redirect URI from configuration.
 * @returns The validated absolute redirect URI.
 * @throws OAuthFlowError when the URI is not an acceptable redirect target.
 */
export function require_redirect_uri(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URI_CHARS) {
    throw new OAuthFlowError("oauth_redirect_not_allowed");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OAuthFlowError("oauth_redirect_not_allowed");
  }
  const has_credentials = parsed.username !== "" || parsed.password !== "";
  const scheme_allowed = parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname));
  if (has_credentials || !scheme_allowed || parsed.hash !== "" || parsed.search !== "") {
    throw new OAuthFlowError("oauth_redirect_not_allowed");
  }
  return parsed.toString();
}

/**
 * Build the immutable redirect allow-list from configuration.
 *
 * @param values - Raw configured redirect URIs; every entry must validate.
 * @returns A frozen, de-duplicated allow-list of absolute redirect URIs.
 * @throws OAuthFlowError when the list is empty, oversized, or has a bad entry.
 */
export function build_redirect_allow_list(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_REDIRECTS) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const normalized = values.map(require_redirect_uri);
  return Object.freeze([...new Set(normalized)]);
}

/**
 * Return the redirect URI this deployment configures for a flow.
 *
 * A route supplies a fixed identifier rather than a URI, so the callback address
 * is always resolved from configuration and validated on the way out. This is the
 * control that stops a request from choosing which callback it is sent to.
 *
 * @param env - Environment mapping.
 * @param variable_name - Configuration variable holding the redirect URI.
 * @returns The validated absolute redirect URI.
 * @throws OAuthFlowError when the variable is absent or malformed.
 */
export function require_configured_redirect(env: Record<string, string | undefined>, variable_name: string): string {
  const value = env[variable_name];
  if (value === undefined || value.trim() === "") throw new OAuthFlowError("oauth_configuration_invalid");
  return require_redirect_uri(value);
}

/**
 * Assert that a proposed redirect URI is on the allow-list.
 *
 * The proposed value normally comes from configuration, but it crosses a
 * boundary when a deployment composes flows dynamically, so it is checked
 * against the allow-list rather than trusted because it was "internal".
 *
 * @param candidate - Redirect URI about to be sent to an IdP.
 * @param allow_list - Allow-list built by `build_redirect_allow_list`.
 * @returns The exact allow-listed value, compared by string equality.
 * @throws OAuthFlowError when the candidate is not on the allow-list.
 */
export function assert_redirect_allowed(candidate: string, allow_list: readonly string[]): string {
  const normalized = require_redirect_uri(candidate);
  if (!Array.isArray(allow_list) || !allow_list.includes(normalized)) {
    throw new OAuthFlowError("oauth_redirect_not_allowed");
  }
  return normalized;
}

/**
 * Validate a browser-supplied relative return path.
 *
 * @param value - Untrusted `return_path` captured when the flow started.
 * @param allowed - Relative paths this deployment permits.
 * @returns The validated relative path.
 * @throws OAuthFlowError when the path is absolute, traverses, escapes the
 * origin, or is not allow-listed.
 */
export function require_return_path(value: string, allowed: readonly string[]): string {
  if (typeof value !== "string" || !RETURN_PATH_PATTERN.test(value)) {
    throw new OAuthFlowError("oauth_return_path_invalid");
  }
  // `//host` and `/a/../b` both pass a naive shape check but change where the
  // browser navigates, so they are rejected explicitly.
  if (value.includes("//") || value.includes("..") || value.includes("\\") || value.endsWith("/")) {
    throw new OAuthFlowError("oauth_return_path_invalid");
  }
  if (!Array.isArray(allowed) || !allowed.includes(value)) {
    throw new OAuthFlowError("oauth_return_path_invalid");
  }
  return value;
}