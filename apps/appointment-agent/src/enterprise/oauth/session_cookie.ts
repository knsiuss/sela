/**
 * Session cookie serialization and the hashing rules for its contents.
 *
 * The cookie carries `<session_id>.<secret>`. The session id is a lookup key;
 * the secret is the actual bearer credential, so only its SHA-256 hash is
 * stored. An attacker who reads the session store therefore cannot forge a
 * cookie, and an attacker who observes a cookie still cannot derive the secret
 * of any other session.
 *
 * Attribute policy is fixed in code rather than configuration, except for
 * `Secure`, which the deployment may relax only through an explicit localhost
 * opt-in. `SameSite=Lax` is required (not `Strict`) because the session cookie
 * must survive the top-level cross-site GET redirect back from the IdP, and
 * `__Host-` is applied whenever the cookie is `Secure`, which forbids a `Domain`
 * attribute and pins `Path=/`.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OAuthFlowError } from "./oauth_error.js";

/** Cookie name used whenever the cookie can be marked `Secure`. */
export const SECURE_SESSION_COOKIE_NAME = "__Host-sel_session";

/** Cookie name for the explicit loopback development opt-in. */
export const INSECURE_SESSION_COOKIE_NAME = "sel_session";

/** Minimum and maximum session lifetime in seconds. */
export const MIN_SESSION_TTL_SECONDS = 300;
export const MAX_SESSION_TTL_SECONDS = 86_400;

const SECRET_ENTROPY_BYTES = 32;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_COOKIE_CHARS = 512;

/** Cookie attributes that every deployment shares. */
export interface SessionCookiePolicy {
  name: string;
  http_only: true;
  same_site: "Lax";
  path: "/";
  secure: boolean;
  max_age_seconds: number;
}

/** One issued session: the id, the raw secret, and the hash to persist. */
export interface IssuedSessionSecret {
  session_id: string;
  secret: string;
  secret_hash: string;
}

/** Cookie policy derived from deployment configuration. */
export interface SessionCookieConfig {
  public_base_url: string;
  /** Explicit opt-in required before `Secure` may be dropped. */
  allow_insecure_loopback: boolean;
  session_ttl_seconds: number;
}

/**
 * Derive the cookie policy, failing closed on an unsafe combination.
 *
 * `Secure` is mandatory unless the deployment both opts in and serves an http
 * loopback origin. A deployment that is not on loopback without `Secure` is a
 * configuration error rather than a warning, because the cookie would then
 * travel in the clear.
 *
 * @param config - Public base URL, loopback opt-in, and session TTL.
 * @returns The policy every session cookie must satisfy.
 * @throws OAuthFlowError when the TTL or the Secure requirement is violated.
 */
export function resolve_session_cookie_policy(config: SessionCookieConfig): SessionCookiePolicy {
  const ttl = config?.session_ttl_seconds;
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < MIN_SESSION_TTL_SECONDS ||
    ttl > MAX_SESSION_TTL_SECONDS
  ) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const base = parse_public_base_url(config?.public_base_url);
  const secure = base.protocol === "https:";
  if (!secure && config.allow_insecure_loopback !== true) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  if (!secure && !LOOPBACK_HOSTS.has(base.hostname)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return {
    name: secure ? SECURE_SESSION_COOKIE_NAME : INSECURE_SESSION_COOKIE_NAME,
    http_only: true,
    same_site: "Lax",
    path: "/",
    secure,
    max_age_seconds: ttl,
  };
}

/**
 * Mint a new session id and secret.
 *
 * A fresh secret per issuance is what prevents session fixation: an identifier
 * chosen before authentication is never reused after it.
 *
 * @param random - Injectable entropy source for deterministic tests.
 * @returns The raw secret to place in the cookie plus the hash to persist.
 * @throws OAuthFlowError when no usable entropy source is available.
 */
export function issue_session_secret(random: () => Buffer = () => randomBytes(SECRET_ENTROPY_BYTES)): IssuedSessionSecret {
  if (typeof random !== "function") throw new OAuthFlowError("oauth_configuration_invalid");
  const session_id = entropy_text(random);
  const secret = entropy_text(random);
  return { session_id, secret, secret_hash: hash_session_secret(secret) };
}

/**
 * Hash a session secret for storage.
 *
 * @param secret - Raw cookie secret; never persisted in this form.
 * @returns SHA-256 hex digest.
 * @throws OAuthFlowError when the secret shape is invalid.
 */
export function hash_session_secret(secret: string): string {
  if (typeof secret !== "string" || !SECRET_PATTERN.test(secret)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Parse a session cookie value into its id and candidate secret.
 *
 * @param cookie_value - Raw `Cookie` header value or single cookie value.
 * @returns The session id and candidate secret, both shape-validated.
 * @throws OAuthFlowError when the value is absent or malformed.
 */
export function parse_session_cookie(cookie_value: string): { session_id: string; secret: string } {
  if (typeof cookie_value !== "string" || cookie_value.length === 0 || cookie_value.length > MAX_COOKIE_CHARS) {
    throw new OAuthFlowError("oauth_session_unavailable");
  }
  const parts = cookie_value.split(".");
  if (parts.length !== 2 || !SESSION_ID_PATTERN.test(parts[0] as string) || !SECRET_PATTERN.test(parts[1] as string)) {
    throw new OAuthFlowError("oauth_session_unavailable");
  }
  return { session_id: parts[0] as string, secret: parts[1] as string };
}

/**
 * Serialize the `Set-Cookie` header value for a session.
 *
 * The value is quoted and `HttpOnly` is unconditional. A clearing cookie uses
 * the same name and attributes with an empty value and a past expiry so the
 * browser drops it even when the policy later flips to `Secure`.
 *
 * @param policy - Policy from `resolve_session_cookie_policy`.
 * @param secret_value - Full `<id>.<secret>` cookie value.
 * @param options - `clear` shortens the expiry to remove the cookie.
 * @returns A complete `Set-Cookie` header value.
 * @throws OAuthFlowError when the policy or the cookie value is malformed.
 */
export function serialize_session_cookie(
  policy: SessionCookiePolicy,
  secret_value: string,
  options: { clear?: boolean } = {},
): string {
  require_policy(policy);
  if (typeof secret_value !== "string" || secret_value.length > MAX_COOKIE_CHARS) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const is_clearing = options.clear === true;
  if (!is_clearing) parse_session_cookie(secret_value);
  const attributes = [
    `${policy.name}=${is_clearing ? "" : secret_value}`,
    `Path=${policy.path}`,
    `SameSite=${policy.same_site}`,
    `Max-Age=${is_clearing ? 0 : policy.max_age_seconds}`,
  ];
  if (policy.http_only) attributes.push("HttpOnly");
  if (policy.secure) attributes.push("Secure");
  return attributes.join("; ");
}

/**
 * Compare a candidate secret against a stored hash in constant time.
 *
 * @param candidate_secret - Secret parsed from the cookie.
 * @param stored_hash - Hash persisted with the session record.
 * @returns True only when the secret matches the stored session.
 */
export function secret_matches(candidate_secret: string, stored_hash: string): boolean {
  if (typeof candidate_secret !== "string" || !SECRET_PATTERN.test(candidate_secret)) return false;
  if (typeof stored_hash !== "string" || !/^[0-9a-f]{64}$/.test(stored_hash)) return false;
  const provided = createHash("sha256").update(candidate_secret, "utf8").digest();
  const expected = Buffer.from(stored_hash, "hex");
  // Both digests are fixed 32 bytes, so any length mismatch is a malformed
  // stored value rather than a secret-dependent fact.
  if (expected.byteLength !== provided.byteLength) return false;
  return timingSafeEqual(provided, expected);
}

/** Validate a parsed public base URL. */
function parse_public_base_url(value: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return parsed;
}

/** Validate that a policy is internally consistent before serializing. */
function require_policy(policy: SessionCookiePolicy): void {
  if (
    policy === undefined ||
    policy.http_only !== true ||
    policy.same_site !== "Lax" ||
    policy.path !== "/" ||
    (policy.name !== SECURE_SESSION_COOKIE_NAME && policy.name !== INSECURE_SESSION_COOKIE_NAME) ||
    (policy.name === SECURE_SESSION_COOKIE_NAME && policy.secure !== true)
  ) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
}

/** Read one 32-byte entropy draw as unpadded base64url. */
function entropy_text(random: () => Buffer): string {
  const entropy = random();
  if (!(entropy instanceof Buffer) || entropy.byteLength !== SECRET_ENTROPY_BYTES) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const encoded = entropy.toString("base64url");
  if (encoded.length !== 43) throw new OAuthFlowError("oauth_configuration_invalid");
  return encoded;
}