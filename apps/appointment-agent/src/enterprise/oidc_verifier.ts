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

/** OIDC verifier that accepts only RS256 access tokens from a configured issuer. */
export class OidcJwtVerifier implements OidcIdentityVerifier {
  private readonly issuer: string;
  private readonly jwks_url: string;
  private readonly audience: string;
  private readonly roles_claim: string;
  private readonly clock_skew_seconds: number;
  private readonly jwks_cache_ms: number;
  private readonly fetch_implementation: typeof globalThis.fetch;
  private readonly clock: () => number;
  private cached_keys: JwksKey[] = [];
  private cached_at_ms = 0;

  /** Create a verifier with explicit issuer, audience, and HTTPS JWKS settings. */
  constructor(options: OidcVerifierOptions) {
    this.issuer = require_https_url(options.issuer_url, "issuer_url");
    this.jwks_url = require_https_url(options.jwks_url, "jwks_url");
    this.audience = required_text(options.audience, "audience", 512);
    this.roles_claim = required_text(options.tenant_roles_claim ?? DEFAULT_ROLES_CLAIM, "tenant_roles_claim", 256);
    this.clock_skew_seconds = bounded_integer(options.clock_skew_seconds ?? DEFAULT_CLOCK_SKEW_SECONDS, "clock_skew_seconds", 600);
    this.jwks_cache_ms = bounded_integer(options.jwks_cache_ms ?? DEFAULT_JWKS_CACHE_MS, "jwks_cache_ms", 86_400_000);
    this.fetch_implementation = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch_implementation !== "function") throw new TypeError("oidc-fetch-invalid");
    this.clock = options.clock ?? Date.now;
  }

  /** Verify signature and registered claims, then normalize enterprise roles. */
  async verify(access_token: string): Promise<AuthenticatedPrincipal> {
    const token = required_text(access_token, "access_token", MAX_TOKEN_BYTES);
    const segments = token.split(".");
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
    this.validate_claims(payload);
    const key = await this.find_key(header.kid);
    const signature = decode_base64url(segments[2]!, "jwt_signature");
    const valid = verify(
      "RSA-SHA256",
      Buffer.from(`${segments[0]}.${segments[1]}`, "utf8"),
      key,
      signature,
    );
    if (!valid) throw new AuthorizationError("unauthenticated");
    return this.to_principal(payload);
  }

  private validate_claims(payload: Record<string, unknown>): void {
    if (
      (payload.iss !== this.issuer && payload.iss !== `${this.issuer}/`) ||
      typeof payload.sub !== "string" ||
      !safe_id(payload.sub)
    ) {
      throw new AuthorizationError("unauthenticated");
    }
    if (!audience_matches(payload.aud, this.audience)) throw new AuthorizationError("unauthenticated");
    const now_seconds = Math.floor(this.clock() / 1_000);
    const skew = this.clock_skew_seconds;
    if (!is_number(payload.exp) || payload.exp + skew < now_seconds) throw new AuthorizationError("unauthenticated");
    if (payload.nbf !== undefined && (!is_number(payload.nbf) || payload.nbf - skew > now_seconds)) {
      throw new AuthorizationError("unauthenticated");
    }
    if (payload.iat !== undefined && (!is_number(payload.iat) || payload.iat > now_seconds + skew)) {
      throw new AuthorizationError("unauthenticated");
    }
    if (typeof payload.sid !== "string" || !safe_id(payload.sid)) throw new AuthorizationError("unauthenticated");
  }

  private async find_key(kid: string): Promise<ReturnType<typeof createPublicKey>> {
    const now_ms = this.clock();
    if (this.cached_keys.length === 0 || now_ms - this.cached_at_ms >= this.jwks_cache_ms) {
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
    const amr = Array.isArray(payload.amr) ? payload.amr : [];
    return parse_authenticated_principal({
      subject_id: payload.sub,
      session_id: payload.sid,
      has_mfa: amr.some((value) => value === "mfa" || value === "otp" || value === "hwk"),
      issued_at_iso: new Date(is_number(payload.iat) ? payload.iat * 1_000 : this.clock()).toISOString(),
      tenant_roles,
    });
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
