/** Minimal signature-verifying OIDC JWT adapter for enterprise operator APIs. */

import { createPublicKey, verify } from "node:crypto";
import {
  AuthorizationError,
  parse_authenticated_principal,
  type AuthenticatedPrincipal,
  type EnterpriseRole,
  type OidcIdentityVerifier,
} from "./authorization.js";

/** Configuration for an explicitly trusted OIDC issuer. */
export interface OidcVerifierOptions {
  issuer_url: string;
  jwks_url: string;
  audience: string;
  tenant_roles_claim?: string;
  clock_skew_seconds?: number;
  jwks_cache_ms?: number;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
}

/** Configuration for signature and registered-claim verification alone. */
export interface Rs256JwtOptions {
  issuer_url: string;
  jwks_url: string;
  audience: string;
  clock_skew_seconds?: number;
  jwks_cache_ms?: number;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
}

/** One cached signing key. */
interface JwksKey {
  kid: string;
  key: ReturnType<typeof createPublicKey>;
}

const DEFAULT_ROLES_CLAIM = "tenant_roles";
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const DEFAULT_JWKS_CACHE_MS = 300_000;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_JWKS_BYTES = 256 * 1024;

/** Authentication methods that prove a second factor was presented. */
const MFA_METHODS: ReadonlySet<string> = new Set([
  "mfa", "otp", "totp", "hwk", "sms", "mfa_aware", "otp_aware", "hwk_aware",
]);

/** Build a verifier from explicit deployment environment settings. */
export function oidc_verifier_from_env(
  env: Record<string, string | undefined> = process.env,
): OidcJwtVerifier {
  const issuer_url = env["OIDC_ISSUER_URL"];
  const jwks_url = env["OIDC_JWKS_URL"];
  const audience = env["OIDC_AUDIENCE"];
  if (issuer_url !== undefined || jwks_url !== undefined || audience !== undefined) {
    if (issuer_url === undefined || jwks_url === undefined || audience === undefined) {
      throw new TypeError("oidc-environment-required");
    }
    return new OidcJwtVerifier({
      issuer_url,
      jwks_url,
      audience,
      ...(env["OIDC_TENANT_ROLES_CLAIM"] === undefined ? {} : { tenant_roles_claim: env["OIDC_TENANT_ROLES_CLAIM"] }),
    });
  }
  // Supabase Auth fallback: same RS256 verifier, issuer/audience supplied
  // through SUPABASE_AUTH_* placeholders. Absent entirely means unconfigured.
  const supabase = supabase_oidc_options_from_env(env);
  if (supabase === undefined) throw new TypeError("oidc-environment-required");
  return new OidcJwtVerifier({
    ...supabase,
    ...(env["OIDC_TENANT_ROLES_CLAIM"] === undefined ? {} : { tenant_roles_claim: env["OIDC_TENANT_ROLES_CLAIM"] }),
  });
}

/** Supabase Auth OIDC settings resolved from environment placeholders. */
export interface SupabaseOidcOptions {
  issuer_url: string;
  jwks_url: string;
  audience: string;
}

/**
 * Read Supabase Auth OIDC settings from the environment.
 *
 * All three SUPABASE_AUTH_* values default to unconfigured; callers must
 * supply the project's own issuer URL, HTTPS JWKS URL, and audience. Never
 * embed a real project URL or key here or in committed configuration.
 *
 * @param env - Environment mapping; defaults to process environment.
 * @returns Supabase OIDC settings, or undefined when none are configured.
 * @throws TypeError when the Supabase triple is only partially configured.
 */
export function supabase_oidc_options_from_env(
  env: Record<string, string | undefined> = process.env,
): SupabaseOidcOptions | undefined {
  const issuer_url = env["SUPABASE_AUTH_ISSUER_URL"];
  const jwks_url = env["SUPABASE_AUTH_JWKS_URL"];
  const audience = env["SUPABASE_AUTH_AUDIENCE"];
  if (issuer_url === undefined && jwks_url === undefined && audience === undefined) return undefined;
  if (issuer_url === undefined || jwks_url === undefined || audience === undefined) {
    throw new TypeError("oidc-environment-required");
  }
  return { issuer_url, jwks_url, audience };
}

/**
 * Decide whether a verified token actually attests a second factor.
 *
 * Providers disagree on the shape of the MFA signal, so all three documented
 * forms are accepted and nothing else:
 *
 * - Supabase Auth emits `aal: "aal2"` and an `amr` array of objects shaped
 *   `{ method, timestamp }`.
 * - Google and generic OIDC providers emit `amr` as an array of method strings.
 * - Some gateways emit an explicit boolean `has_mfa` claim.
 *
 * An `amr` entry that is neither a known string nor an object with a known
 * `method` grants nothing, so an unfamiliar claim shape fails closed to
 * "unverified MFA" and therefore blocks privileged actions.
 *
 * @param payload - Claims from an already signature-verified token.
 * @returns True only when a recognised second-factor signal is present.
 */
export function has_verified_mfa(payload: Record<string, unknown>): boolean {
  if (payload["aal"] === "aal2") return true;
  if (payload["has_mfa"] === true) return true;
  const amr = payload["amr"];
  if (!Array.isArray(amr)) return false;
  return amr.some((entry) => {
    if (typeof entry === "string") return MFA_METHODS.has(entry.toLowerCase());
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const method = (entry as Record<string, unknown>)["method"];
    return typeof method === "string" && MFA_METHODS.has(method.toLowerCase());
  });
}

/**
 * Verify an RS256 JWT signature and its registered claims.
 *
 * This is the shared half used by both the operator API bearer verifier and the
 * ID-token verifier behind staff login. It deliberately does not require a
 * `sid` claim or any application-specific claim, because an OIDC ID token
 * carries neither.
 *
 * @param token - Compact JWS from an Authorization header or token response.
 * @param options - Trusted issuer, audience, HTTPS JWKS URL, and clocks.
 * @returns The verified claim set.
 * @throws AuthorizationError for any malformed, unsigned, expired, or
 * wrongly-scoped token, and TypeError for unusable issuer/JWKS configuration.
 */
export async function verify_rs256_jwt(
  token: string,
  options: Rs256JwtOptions,
): Promise<Record<string, unknown>> {
  const issuer = require_https_url(options.issuer_url, "issuer_url");
  const jwks = new JwksKeySet(options);
  const skew = bounded_integer(options.clock_skew_seconds ?? DEFAULT_CLOCK_SKEW_SECONDS, "clock_skew_seconds", 600);
  const clock = options.clock ?? Date.now;
  const compact = required_text(token, "access_token", MAX_TOKEN_BYTES);
  const segments = compact.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new AuthorizationError("unauthenticated");
  }
  const header = decode_json(segments[0]!, "jwt_header");
  const payload = decode_json(segments[1]!, "jwt_payload");
  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    header.kid.length > 256 ||
    header.crit !== undefined
  ) {
    throw new AuthorizationError("unauthenticated");
  }
  validate_registered_claims(payload, issuer, options.audience, skew, clock);
  const key = await jwks.find(header.kid);
  const signature = decode_base64url(segments[2]!, "jwt_signature");
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${segments[0]}.${segments[1]}`, "utf8"),
    key,
    signature,
  );
  if (!valid) throw new AuthorizationError("unauthenticated");
  return payload;
}

/** OIDC verifier that accepts only RS256 access tokens from a configured issuer. */
export class OidcJwtVerifier implements OidcIdentityVerifier {
  private readonly audience: string;
  private readonly roles_claim: string;
  private readonly keys: JwksKeySet;
  private readonly clock: () => number;
  private readonly skew: number;
  private readonly issuer: string;

  /** Create a verifier with explicit issuer, audience, and HTTPS JWKS settings. */
  constructor(options: OidcVerifierOptions) {
    this.issuer = require_https_url(options.issuer_url, "issuer_url");
    this.keys = new JwksKeySet(options);
    this.audience = required_text(options.audience, "audience", 512);
    this.roles_claim = required_text(options.tenant_roles_claim ?? DEFAULT_ROLES_CLAIM, "tenant_roles_claim", 256);
    this.skew = bounded_integer(options.clock_skew_seconds ?? DEFAULT_CLOCK_SKEW_SECONDS, "clock_skew_seconds", 600);
    this.clock = options.clock ?? Date.now;
  }

  /** Verify signature and registered claims, then normalize enterprise roles. */
  async verify(access_token: string): Promise<AuthenticatedPrincipal> {
    const compact = required_text(access_token, "access_token", MAX_TOKEN_BYTES);
    const segments = compact.split(".");
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
      throw new AuthorizationError("unauthenticated");
    }
    const header = decode_json(segments[0]!, "jwt_header");
    const payload = decode_json(segments[1]!, "jwt_payload");
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      header.kid.length > 256 ||
      header.crit !== undefined
    ) {
      throw new AuthorizationError("unauthenticated");
    }
    validate_registered_claims(payload, this.issuer, this.audience, this.skew, this.clock);
    const key = await this.keys.find(header.kid);
    const signature = decode_base64url(segments[2]!, "jwt_signature");
    const valid = verify("RSA-SHA256", Buffer.from(`${segments[0]}.${segments[1]}`, "utf8"), key, signature);
    if (!valid) throw new AuthorizationError("unauthenticated");
    return this.to_principal(payload);
  }

  private to_principal(payload: Record<string, unknown>): AuthenticatedPrincipal {
    const raw_roles = payload[this.roles_claim];
    if (typeof raw_roles !== "object" || raw_roles === null || Array.isArray(raw_roles)) {
      throw new AuthorizationError("unauthenticated");
    }
    const tenant_roles: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const [tenant_id, roles] of Object.entries(raw_roles)) {
      if (!Array.isArray(roles) || roles.some((role) => !is_enterprise_role(role))) {
        throw new AuthorizationError("unauthenticated");
      }
      tenant_roles[tenant_id] = roles as string[];
    }
    if (typeof payload.sid !== "string" || !safe_id(payload.sid)) throw new AuthorizationError("unauthenticated");
    return parse_authenticated_principal({
      subject_id: payload.sub,
      session_id: payload.sid,
      has_mfa: has_verified_mfa(payload),
      issued_at_iso: new Date(is_number(payload.iat) ? payload.iat * 1_000 : this.clock()).toISOString(),
      tenant_roles,
    });
  }
}

/** Bounded HTTPS JWKS cache shared by one verifier instance. */
class JwksKeySet {
  private readonly jwks_url: string;
  private readonly fetch_implementation: typeof globalThis.fetch;
  private readonly clock: () => number;
  private readonly cache_ms: number;
  private cached_keys: JwksKey[] = [];
  private cached_at_ms = 0;

  constructor(options: Rs256JwtOptions) {
    this.jwks_url = require_https_url(options.jwks_url, "jwks_url");
    this.fetch_implementation = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch_implementation !== "function") throw new TypeError("oidc-fetch-invalid");
    this.clock = options.clock ?? Date.now;
    this.cache_ms = bounded_integer(options.jwks_cache_ms ?? DEFAULT_JWKS_CACHE_MS, "jwks_cache_ms", 86_400_000);
  }

  /**
   * Resolve a signing key by key id, refreshing the cache only on expiry.
   *
   * @param kid - Key id from the JWS header.
   * @returns The matching RSA public key.
   * @throws AuthorizationError when the key id is unknown or the JWKS is unusable.
   */
  async find(kid: string): Promise<ReturnType<typeof createPublicKey>> {
    const now_ms = this.clock();
    if (this.cached_keys.length === 0 || now_ms - this.cached_at_ms >= this.cache_ms) {
      this.cached_keys = await this.load_keys();
      this.cached_at_ms = now_ms;
    }
    // Do not refresh on every unknown kid: an unauthenticated caller could
    // otherwise turn arbitrary token headers into a JWKS request flood.
    const found = this.cached_keys.find((candidate) => candidate.kid === kid);
    if (found === undefined) throw new AuthorizationError("unauthenticated");
    return found.key;
  }

  private async load_keys(): Promise<JwksKey[]> {
    let response: Response;
    try {
      response = await this.fetch_implementation(this.jwks_url, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new AuthorizationError("unauthenticated");
    }
    if (!response.ok) throw new AuthorizationError("unauthenticated");
    const content_length = response.headers.get("content-length");
    if (content_length !== null && Number(content_length) > MAX_JWKS_BYTES) {
      throw new AuthorizationError("unauthenticated");
    }
    let payload: unknown;
    try {
      const body_text = await response.text();
      if (Buffer.byteLength(body_text, "utf8") > MAX_JWKS_BYTES) throw new Error("jwks-too-large");
      payload = JSON.parse(body_text);
    } catch {
      throw new AuthorizationError("unauthenticated");
    }
    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { keys?: unknown }).keys)) {
      throw new AuthorizationError("unauthenticated");
    }
    const keys: JwksKey[] = [];
    for (const raw of (payload as { keys: unknown[] }).keys) {
      if (typeof raw !== "object" || raw === null) continue;
      const jwk = raw as Record<string, unknown>;
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
      if (jwk.d !== undefined || jwk.p !== undefined || jwk.q !== undefined) continue;
      if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      try {
        keys.push({ kid: jwk.kid, key: createPublicKey({ key: jwk as unknown as globalThis.JsonWebKey, format: "jwk" }) });
      } catch {
        throw new AuthorizationError("unauthenticated");
      }
    }
    if (keys.length === 0 || keys.length > 100) throw new AuthorizationError("unauthenticated");
    return keys;
  }
}

/** Validate issuer, subject, audience, and the time-based registered claims. */
function validate_registered_claims(
  payload: Record<string, unknown>,
  issuer: string,
  audience: string,
  skew: number,
  clock: () => number,
): void {
  if (
    (payload.iss !== issuer && payload.iss !== `${issuer}/`) ||
    typeof payload.sub !== "string" ||
    !safe_id(payload.sub)
  ) {
    throw new AuthorizationError("unauthenticated");
  }
  if (!audience_matches(payload.aud, audience)) throw new AuthorizationError("unauthenticated");
  const now_seconds = Math.floor(clock() / 1_000);
  if (!is_number(payload.exp) || payload.exp + skew < now_seconds) throw new AuthorizationError("unauthenticated");
  if (payload.nbf !== undefined && (!is_number(payload.nbf) || payload.nbf - skew > now_seconds)) {
    throw new AuthorizationError("unauthenticated");
  }
  if (payload.iat !== undefined && (!is_number(payload.iat) || payload.iat > now_seconds + skew)) {
    throw new AuthorizationError("unauthenticated");
  }
}

function decode_json(value: string, field_name: string): Record<string, unknown> {
  const bytes = decode_base64url(value, field_name);
  if (bytes.byteLength > MAX_TOKEN_BYTES) throw new AuthorizationError("unauthenticated");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new AuthorizationError("unauthenticated");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AuthorizationError("unauthenticated");
  }
  return parsed as Record<string, unknown>;
}

function decode_base64url(value: string, field_name: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_TOKEN_BYTES) throw new AuthorizationError("unauthenticated");
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new AuthorizationError("unauthenticated");
  }
}

function audience_matches(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.some((entry) => entry === expected));
}

function require_https_url(value: string, field_name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${field_name}-invalid`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.port !== "" && parsed.port !== "443")
  ) {
    throw new TypeError(`${field_name}-invalid`);
  }
  return parsed.toString().replace(/\/$/u, "");
}

function required_text(value: string, field_name: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${field_name}-invalid`);
  }
  return value;
}

function bounded_integer(value: number, field_name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TypeError(`${field_name}-invalid`);
  return value;
}

function safe_id(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function is_number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function is_enterprise_role(value: unknown): value is EnterpriseRole {
  return value === "owner" || value === "admin" || value === "operator" || value === "support" || value === "analyst" || value === "developer";
}