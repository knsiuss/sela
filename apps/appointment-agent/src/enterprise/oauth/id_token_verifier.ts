/**
 * OIDC ID-token verification for staff login.
 *
 * The operator API already verifies *access* tokens through `OidcJwtVerifier`,
 * but an ID token is the right credential for a login callback: it is the only
 * one that carries `nonce`, `auth_time`, and `email_verified`, and its audience
 * is the OAuth client id rather than the resource audience. Both identity
 * providers in scope agree on that shape:
 *
 * - Supabase Auth returns an ID token only when the `openid` scope was
 *   requested, and that token has `aud` = the registered OAuth client id, with
 *   `nonce` echoed from the authorization request.
 * - Google returns an ID token signed with RS256 whose `aud` is the client id,
 *   with `nonce` echoed, plus an optional `hd` claim naming the Workspace
 *   hosted domain of the account.
 *
 * Signature and registered-claim verification is delegated to the shared
 * `verify_rs256_jwt`, so there is exactly one RS256/JWKS implementation in the
 * codebase and the operator-API behaviour cannot drift from login behaviour.
 */

import { timingSafeEqual } from "node:crypto";
import { has_verified_mfa, verify_rs256_jwt, type Rs256JwtOptions } from "../oidc_verifier.js";
import { OAuthFlowError } from "./oauth_error.js";

/** One staff identity proven by a verified ID token. */
export interface VerifiedStaffIdentity {
  /** Issuer-stable subject identifier; the only identity we persist. */
  subject_id: string;
  /** Normalized issuer that produced the token. */
  issuer: string;
  /** Whether the provider asserts the account's email address is verified. */
  email_verified: boolean;
  /** Whether the token attests a second factor. */
  has_mfa: boolean;
}

/**
 * Configuration for one identity provider's ID tokens.
 *
 * The audience is named `staff_audience` rather than inherited as `audience`
 * because an ID token's audience is the OAuth client id, not the resource
 * audience the operator API bearer verifier expects. Conflating them would let a
 * token minted for the API be replayed as a login credential.
 */
export interface IdTokenVerifierOptions extends Omit<Rs256JwtOptions, "audience"> {
  /** Expected `aud`: the OAuth client id registered with the provider. */
  staff_audience: string;
  /**
   * Optional Google Workspace hosted domain, for example `example.com`.
   *
   * When set, the token's `hd` claim must match exactly. This is what restricts
   * "sign in with Google" to the tenant's own Workspace accounts.
   */
  expected_hosted_domain?: string;
}

/** Verify an ID token and return the normalized staff identity. */
export async function verify_staff_id_token(
  id_token: string,
  expected_nonce: string,
  options: IdTokenVerifierOptions,
): Promise<VerifiedStaffIdentity> {
  if (typeof expected_nonce !== "string" || expected_nonce.length < 16 || expected_nonce.length > 256) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const audience = require_audience(options.staff_audience);
  let payload: Record<string, unknown>;
  try {
    payload = await verify_rs256_jwt(id_token, {
      issuer_url: options.issuer_url,
      jwks_url: options.jwks_url,
      audience,
      ...(options.clock_skew_seconds === undefined ? {} : { clock_skew_seconds: options.clock_skew_seconds }),
      // Forwarded so a deployment that holds one key set per provider keeps its
      // JWKS cache across logins instead of refetching per verification.
      ...(options.jwks_cache_ms === undefined ? {} : { jwks_cache_ms: options.jwks_cache_ms }),
      ...(options.key_set === undefined ? {} : { key_set: options.key_set }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
  } catch {
    // The underlying AuthorizationError is deliberately collapsed: it carries
    // no useful detail for a caller and its message could echo token material.
    throw new OAuthFlowError("oauth_identity_unverified");
  }
  assert_nonce(payload, expected_nonce);
  assert_authorized_party(payload, audience);
  assert_hosted_domain(payload, options.expected_hosted_domain);
  return {
    subject_id: payload.sub as string,
    issuer: normalize_issuer(payload.iss as string),
    email_verified: payload.email_verified === true,
    has_mfa: has_verified_mfa(payload),
  };
}

/**
 * Require the ID token to echo the nonce this flow generated.
 *
 * @param payload - Verified claim set.
 * @param expected_nonce - Nonce stored with the state record.
 * @throws OAuthFlowError when the nonce is absent, malformed, or different.
 */
function assert_nonce(payload: Record<string, unknown>, expected_nonce: string): void {
  const nonce = payload["nonce"];
  if (typeof nonce !== "string" || nonce.length > 256) throw new OAuthFlowError("oauth_nonce_mismatch");
  const provided = Buffer.from(nonce, "utf8");
  const expected = Buffer.from(expected_nonce, "utf8");
  // A length mismatch is not secret because a nonce length is chosen by this
  // process; only the digest comparison must avoid a timing oracle.
  if (provided.byteLength !== expected.byteLength || !timingSafeEqual(provided, expected)) {
    throw new OAuthFlowError("oauth_nonce_mismatch");
  }
}

/**
 * Require `azp` to match the expected audience when the provider sets it.
 *
 * @param payload - Verified claim set.
 * @param audience - Expected audience value.
 * @throws OAuthFlowError when a conflicting authorized party is present.
 */
function assert_authorized_party(payload: Record<string, unknown>, audience: string): void {
  const azp = payload["azp"];
  if (azp === undefined) return;
  if (typeof azp !== "string" || azp !== audience) throw new OAuthFlowError("oauth_identity_unverified");
}

/**
 * Require the Google Workspace hosted domain when one is configured.
 *
 * @param payload - Verified claim set.
 * @param expected - Configured hosted domain, or undefined to skip.
 * @throws OAuthFlowError when the domain is absent or does not match.
 */
function assert_hosted_domain(payload: Record<string, unknown>, expected: string | undefined): void {
  if (expected === undefined) return;
  const hd = payload["hd"];
  if (typeof hd !== "string" || hd.toLowerCase() !== expected.toLowerCase()) {
    throw new OAuthFlowError("oauth_identity_unverified");
  }
}

/**
 * Validate the staff audience value.
 *
 * @param value - Configured audience, normally the OAuth client id.
 * @returns The validated audience.
 * @throws OAuthFlowError when the audience is missing or malformed.
 */
function require_audience(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.trim() !== value) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}

/**
 * Normalize an issuer for stable persistence.
 *
 * @param value - Verified `iss` claim.
 * @returns Issuer without a trailing slash.
 * @throws OAuthFlowError when the issuer is unusable.
 */
function normalize_issuer(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new OAuthFlowError("oauth_identity_unverified");
  }
  return value.replace(/\/$/u, "");
}
