/**
 * Fail-closed configuration for staff authentication.
 *
 * There is no implicit default. A deployment that configures no identity
 * provider, or only part of one, or omits the redirect allow-list, gets
 * `oauth_configuration_invalid` at startup rather than an unauthenticated
 * dashboard. That is the whole point: local development must not silently fall
 * back to open access, so the absence of configuration is an error, not a mode.
 *
 * Each provider is described by its own record because the two differ in the
 * fields they need: Supabase needs an issuer, JWKS URL, audience, and client
 * credentials; Google additionally supports a Workspace hosted-domain
 * restriction that is the control that keeps "sign in with Google" inside the
 * tenant's own accounts. Every field a provider lists is enforced: a pinned
 * staff audience that disagrees with the client id is refused rather than
 * ignored, so an operator cannot believe a value is in force when it is not.
 */

import {
  assert_redirect_allowed,
  build_redirect_allow_list,
  require_redirect_uri,
} from "./redirect_policy.js";
import { resolve_session_cookie_policy, type SessionCookiePolicy } from "./session_cookie.js";
import { OAuthFlowError } from "./oauth_error.js";
import { parse_source_admission_policy, type SourceAdmissionPolicy } from "./source_admission.js";
import type { StaffIdentityProvider } from "./oauth_state.js";

/** Configuration for one identity provider. */
export interface IdProviderConfig {
  idp: StaffIdentityProvider;
  issuer_url: string;
  jwks_url: string;
  /** OAuth client id; also the expected ID-token audience. */
  client_id: string;
  /** OAuth client secret; required because both providers use confidential clients. */
  client_secret: string;
  /**
   * Expected ID-token audience, pinned by configuration.
   *
   * An ID token's audience is the OAuth client id, so this must equal
   * `client_id`. It is a separate setting because an operator can pin it
   * explicitly, and a value that disagrees with the client id is a configuration
   * error rather than a silently ignored field.
   */
  staff_audience: string;
  /** Google Workspace hosted domain, when the tenant restricts sign-in to it. */
  hosted_domain?: string;
}

/** Complete, validated staff authentication configuration. */
export interface StaffAuthConfig {
  /** Enabled providers; empty is a configuration error, not "open access". */
  providers: readonly IdProviderConfig[];
  /** Absolute login callback URI, present in the redirect allow-list. */
  login_redirect_uri: string;
  /** Absolute Calendar consent callback URI, present in the redirect allow-list. */
  calendar_redirect_uri: string;
  redirect_allow_list: readonly string[];
  /**
   * Normalized origin the dashboard is served from, without a trailing slash.
   *
   * Post-credential redirects must be built from this rather than from the
   * request's `Host`, which is attacker-influenceable on any deployment that
   * accepts an arbitrary Host header.
   */
  public_base_url: string;
  cookie: SessionCookiePolicy;
  /** Google Calendar scopes requested during consent. */
  calendar_scopes: readonly string[];
  session_ttl_seconds: number;
  /**
   * Signing-key cache lifetime in milliseconds.
   *
   * This is the window in which a key the issuer has already rotated or
   * emergency-revoked keeps validating locally, so it is configuration rather
   * than a constant: a deployment balancing rotation downtime against that
   * window picks it deliberately, and a value outside the supported bounds is
   * refused at startup instead of being rounded into something believable.
   */
  jwks_cache_ms: number;
  /**
   * Per-source admission limits applied to the login and consent entry points.
   *
   * These are the control that keeps one anonymous source from filling the state
   * store, so they are configuration rather than constants: the sustainable login
   * rate of a deployment differs from an internal console to a busy clinic.
   */
  admission: SourceAdmissionPolicy;
  /**
   * Number of trusted reverse proxies in front of this deployment.
   *
   * Zero means `X-Forwarded-For` is not trusted at all and every direct caller
   * shares one admission bucket. A positive value is how many proxies append to
   * that header, which is what lets a proxied deployment bucket per client rather
   * than per proxy. It is explicit because getting it wrong in the trusting
   * direction hands an anonymous caller a fresh bucket per request.
   */
  trusted_proxy_hops: number;
}

/** Environment variable holding a comma-separated or JSON redirect list. */
export const REDIRECT_ALLOW_LIST_ENV = "STAFF_AUTH_REDIRECT_ALLOW_LIST";

/** Environment variable holding the signing-key cache lifetime in seconds. */
export const JWKS_CACHE_MS_ENV = "STAFF_AUTH_JWKS_CACHE_MS";

/** Environment variable holding the trusted reverse-proxy count. */
export const TRUSTED_PROXY_HOPS_ENV = "STAFF_AUTH_TRUSTED_PROXY_HOPS";

/** Scopes requested for Calendar; read/write events plus read-only metadata. */
export const DEFAULT_CALENDAR_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const MAX_SECRET_CHARS = 512;
const MAX_ALLOW_LIST_ENTRIES = 8;
const MAX_PUBLIC_BASE_URL_CHARS = 2048;
const MIN_JWKS_CACHE_SECONDS = 30;
const MAX_JWKS_CACHE_SECONDS = 3_600;
const DEFAULT_JWKS_CACHE_SECONDS = 300;
const MAX_TRUSTED_PROXY_HOPS = 8;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HOSTED_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Build staff authentication configuration from the environment.
 *
 * @param env - Environment mapping; defaults to the process environment.
 * @returns A validated configuration safe to serve login from.
 * @throws OAuthFlowError when no provider is fully configured, when a provider
 * is partially configured, when a redirect URI is not allow-listed, or when the
 * cookie policy would put a session cookie on the wire in the clear.
 */
export function parse_staff_auth_config(env: Record<string, string | undefined> = process.env): StaffAuthConfig {
  const providers = collect_providers(env);
  if (providers.length === 0) throw new OAuthFlowError("oauth_configuration_invalid");
  const allow_list = parse_allow_list(env[REDIRECT_ALLOW_LIST_ENV]);
  const login_redirect_uri = assert_redirect_allowed(require_redirect_uri(text(env, "STAFF_AUTH_LOGIN_REDIRECT_URI")), allow_list);
  const calendar_redirect_uri = assert_redirect_allowed(
    require_redirect_uri(text(env, "STAFF_AUTH_CALENDAR_REDIRECT_URI")),
    allow_list,
  );
  const ttl = require_ttl(env["STAFF_AUTH_SESSION_TTL_SECONDS"]);
  const public_base_url = require_public_base_url(text(env, "STAFF_AUTH_PUBLIC_BASE_URL"));
  const cookie = resolve_session_cookie_policy({
    public_base_url,
    allow_insecure_loopback: env["STAFF_AUTH_ALLOW_INSECURE_LOOPBACK"] === "true",
    session_ttl_seconds: ttl,
  });
  return {
    providers,
    login_redirect_uri,
    calendar_redirect_uri,
    redirect_allow_list: allow_list,
    public_base_url,
    cookie,
    calendar_scopes: parse_calendar_scopes(env["STAFF_AUTH_CALENDAR_SCOPES_JSON"]),
    session_ttl_seconds: ttl,
    jwks_cache_ms: require_jwks_cache_ms(env[JWKS_CACHE_MS_ENV]),
    admission: parse_source_admission_policy(env),
    trusted_proxy_hops: require_trusted_proxy_hops(env[TRUSTED_PROXY_HOPS_ENV]),
  };
}

/**
 * Report whether the configured public origin is a loopback address.
 *
 * The in-memory state, session, and grant stores are single-process, so a
 * deployment that publishes the dashboard beyond loopback would serve logins it
 * cannot share between instances. A composition root that selects the in-memory
 * stores must refuse to start unless this returns true.
 *
 * @param config - Validated staff authentication configuration.
 * @returns True when the public base URL names a loopback host.
 */
export function is_loopback_public_base_url(config: StaffAuthConfig): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(config.public_base_url).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve one enabled provider by identity.
 *
 * @param config - Validated staff authentication configuration.
 * @param idp - Provider requested by the route.
 * @returns The provider configuration.
 * @throws OAuthFlowError when that provider is not enabled, so a request can
 * never fall back to the other provider.
 */
export function require_provider(config: StaffAuthConfig, idp: StaffIdentityProvider): IdProviderConfig {
  const found = config.providers.find((provider) => provider.idp === idp);
  if (found === undefined) throw new OAuthFlowError("oauth_idp_unknown");
  return found;
}

/**
 * Collect fully configured providers, refusing partial ones.
 *
 * @param env - Environment mapping.
 * @returns Every complete provider configuration.
 * @throws OAuthFlowError when a provider's fields are only partly present.
 */
function collect_providers(env: Record<string, string | undefined>): IdProviderConfig[] {
  const providers: IdProviderConfig[] = [];
  const supabase = read_provider(env, "supabase", "SUPABASE_AUTH_OAUTH_CLIENT_ID", "SUPABASE_AUTH_OAUTH_CLIENT_SECRET");
  if (supabase !== undefined) providers.push(supabase);
  const google = read_provider(env, "google", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET");
  if (google !== undefined) {
    providers.push(with_hosted_domain(google, env["GOOGLE_WORKSPACE_HOSTED_DOMAIN"]));
  }
  return providers;
}

/**
 * Read one provider's fields, treating all-or-nothing as the only valid state.
 *
 * The staff audience is required and is checked against the client id: an ID
 * token's audience is the OAuth client id, so a pinned value that disagrees is a
 * configuration error rather than a field the deployment believes is in force.
 *
 * @param env - Environment mapping.
 * @param idp - Provider identifier.
 * @param client_id_env - Client id variable name.
 * @param client_secret_env - Client secret variable name.
 * @returns The provider configuration, or undefined when unconfigured.
 * @throws OAuthFlowError when any field is present but the set is incomplete, or
 * when the pinned staff audience is not the client id.
 */
function read_provider(
  env: Record<string, string | undefined>,
  idp: StaffIdentityProvider,
  client_id_env: string,
  client_secret_env: string,
): IdProviderConfig | undefined {
  const client_id = env[client_id_env];
  const client_secret = env[client_secret_env];
  const issuer_url = env[idp === "supabase" ? "SUPABASE_AUTH_ISSUER_URL" : "GOOGLE_OAUTH_ISSUER_URL"];
  const jwks_url = env[idp === "supabase" ? "SUPABASE_AUTH_JWKS_URL" : "GOOGLE_OAUTH_JWKS_URL"];
  const audience = env[idp === "supabase" ? "SUPABASE_AUTH_STAFF_AUDIENCE" : "GOOGLE_OAUTH_STAFF_AUDIENCE"];
  const present = [client_id, client_secret, issuer_url, jwks_url, audience].filter((value) => value !== undefined && value !== "");
  if (present.length === 0) return undefined;
  if (present.length !== 5) throw new OAuthFlowError("oauth_configuration_invalid");
  const normalized_client_id = require_secret_value(client_id as string);
  const normalized_audience = require_secret_value(audience as string);
  if (normalized_audience !== normalized_client_id) throw new OAuthFlowError("oauth_configuration_invalid");
  return {
    idp,
    issuer_url: require_https(issuer_url as string),
    jwks_url: require_https(jwks_url as string),
    client_id: normalized_client_id,
    client_secret: require_secret_value(client_secret as string),
    staff_audience: normalized_audience,
  };
}

/** Attach an optional Google Workspace hosted-domain restriction. */
function with_hosted_domain(provider: IdProviderConfig, hosted_domain: string | undefined): IdProviderConfig {
  if (hosted_domain === undefined || hosted_domain === "") return provider;
  const normalized = hosted_domain.toLowerCase();
  if (normalized.length > 253 || !HOSTED_DOMAIN_PATTERN.test(normalized)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return { ...provider, hosted_domain: normalized };
}

/**
 * Parse the redirect allow-list, accepting a JSON array or a comma-separated list.
 *
 * @param raw - Raw configuration value.
 * @returns A validated, frozen allow-list.
 * @throws OAuthFlowError when the value is absent, malformed, or oversized.
 */
function parse_allow_list(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") throw new OAuthFlowError("oauth_configuration_invalid");
  let entries: string[];
  if (raw.trimStart().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) throw new OAuthFlowError("oauth_configuration_invalid");
    entries = parsed.map((entry) => {
      if (typeof entry !== "string") throw new OAuthFlowError("oauth_configuration_invalid");
      return entry;
    });
  } else {
    entries = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  }
  if (entries.length > MAX_ALLOW_LIST_ENTRIES) throw new OAuthFlowError("oauth_configuration_invalid");
  return build_redirect_allow_list(entries);
}

/** Parse an optional Calendar scope list. */
function parse_calendar_scopes(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CALENDAR_SCOPES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return parsed.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 256) {
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
    return entry;
  });
}

/** Read a required environment variable. */
function text(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new OAuthFlowError("oauth_configuration_invalid");
  return value;
}

/** Require an https URL with no credentials, query, or fragment. */
function require_https(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return parsed.toString().replace(/\/$/u, "");
}

/** Require a bounded, trimmed credential-shaped value. */
function require_secret_value(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SECRET_CHARS || value.trim() !== value) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}

/**
 * Normalize the configured public origin used for post-credential redirects.
 *
 * The value is required here rather than being re-derived per request: a
 * redirect built from the request's `Host` header would send a freshly issued
 * session cookie to whatever host the caller named.
 *
 * @param value - Raw `STAFF_AUTH_PUBLIC_BASE_URL` value.
 * @returns The origin without a trailing slash.
 * @throws OAuthFlowError when the value is absent or is not an absolute origin.
 */
function require_public_base_url(value: string): string {
  if (value.length === 0 || value.length > MAX_PUBLIC_BASE_URL_CHARS) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
  ) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return parsed.origin;
}

/** Require a bounded integer TTL in seconds. */
function require_ttl(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 3600;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 300 || parsed > 86_400) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return parsed;
}

/**
 * Read the signing-key cache lifetime, in seconds, from the environment.
 *
 * An absent value keeps the previous five-minute default. A value that is
 * present but out of bounds, fractional, or not a number is a configuration
 * error rather than a silent fallback: an operator must not believe a rotation
 * window is in force when the value they set was ignored.
 *
 * @param raw - Raw `STAFF_AUTH_JWKS_CACHE_MS` value.
 * @returns The cache lifetime in milliseconds.
 * @throws OAuthFlowError when the value is not a whole number of seconds in
 * [30, 3600].
 */
function require_jwks_cache_ms(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_JWKS_CACHE_SECONDS * 1_000;
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_JWKS_CACHE_SECONDS ||
    parsed > MAX_JWKS_CACHE_SECONDS
  ) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return parsed * 1_000;
}

/**
 * Read how many reverse proxies are trusted to append `X-Forwarded-For`.
 *
 * Zero is the safe default: an untrusted deployment must not derive an admission
 * bucket from a header the caller wrote, because that would give one source a
 * fresh bucket per request.
 *
 * @param raw - Raw `STAFF_AUTH_TRUSTED_PROXY_HOPS` value.
 * @returns The trusted hop count in [0, 8].
 * @throws OAuthFlowError when the value is present but not an integer in range.
 */
function require_trusted_proxy_hops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) throw new OAuthFlowError("oauth_configuration_invalid");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_TRUSTED_PROXY_HOPS) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return parsed;
}
