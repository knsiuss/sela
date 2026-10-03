/**
 * The authorization-code flow, written once and shared by staff login and
 * Calendar consent.
 *
 * Both flows have the same shape and the same failure semantics, so they live in
 * one module: mint a state bound to a purpose, tenant, and return path; carry
 * PKCE and a nonce to the IdP; then on the callback claim the state exactly once,
 * exchange the code with the verifier, verify the ID token's nonce, and only then
 * establish anything privileged. Keeping them together is what makes it
 * impossible to apply the CSRF control to login and forget it on consent.
 *
 * The ordering in `complete_authorization` is the security-relevant part:
 *
 * 1. The state record is claimed first, so an unknown, expired, or replayed
 *    state never reaches the token endpoint.
 * 2. The record's IdP and purpose must match the route, so a login state cannot
 *    be spent on a Calendar consent callback or vice versa.
 * 3. The provider's `error` is inspected only after the state claim, so an
 *    attacker cannot use an error redirect to probe whether a state exists.
 * 4. The code is exchanged with the stored PKCE verifier, and the ID token is
 *    verified against the stored nonce before any identity is materialized.
 *
 * Every failure collapses to an `OAuthFlowError` code. No code, state, nonce,
 * verifier, token, or email address is ever returned, because these results are
 * logged and rendered.
 */

import { randomBytes } from "node:crypto";
import { build_google_consent_url } from "./google_authorize.js";
import { OAuthFlowError } from "./oauth_error.js";
import { generate_pkce_pair } from "./pkce.js";
import { require_return_path } from "./redirect_policy.js";
import { verify_staff_id_token, type VerifiedStaffIdentity } from "./id_token_verifier.js";
import type {
  OAuthFlowPurpose,
  OAuthStateRecord,
  OAuthStateStore,
  StaffIdentityProvider,
} from "./oauth_state.js";
import type { AuthorizationCodeExchanger, AuthorizationCodeTokens } from "./code_exchangers.js";
import type { IdTokenVerifierOptions } from "./id_token_verifier.js";

const NONCE_ENTROPY_BYTES = 24;
const MAX_CODE_CHARS = 4096;

/** One authorize redirect, ready to send as a 302. */
export interface AuthorizationRedirect {
  /** Absolute IdP URL carrying state, PKCE challenge, and nonce. */
  authorization_url: string;
  redirect_uri: string;
}

/** Everything needed to start one authorization request. */
export interface BeginAuthorizationInput {
  idp: StaffIdentityProvider;
  /** Provider issuer; the authorize endpoint is derived from it for Supabase. */
  issuer_url: string;
  client_id: string;
  redirect_uri: string;
  /** Tenant the flow is bound to, or null for tenant-agnostic login. */
  tenant_id: string | null;
  /** Browser-supplied return path, validated against the deployment allow-list. */
  return_path: string;
  /** Scopes to request from the IdP. */
  scopes: readonly string[];
  /** Google only: request offline access so a refresh token is issued. */
  offline_access?: boolean;
}

/** Everything needed to finish one authorization request. */
export interface CompleteAuthorizationInput {
  idp: StaffIdentityProvider;
  expected_purpose: OAuthFlowPurpose;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  params: OAuthCallbackParams;
  /** Return paths this deployment permits after a successful callback. */
  allowed_return_paths: readonly string[];
}

/** Untrusted callback query parameters. */
export interface OAuthCallbackParams {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}

/** A callback whose state, PKCE, nonce, and ID token all verified. */
export interface CompletedAuthorization {
  record: OAuthStateRecord;
  identity: VerifiedStaffIdentity;
  /**
   * Provider tokens. Callers must not log any field and must not retain
   * `access_token` or `id_token`; a Calendar consent callback needs only
   * `refresh_token`.
   */
  tokens: AuthorizationCodeTokens;
}

/**
 * Mint a state record and build the IdP authorize redirect together.
 *
 * The state is issued through the store in the same call that produces the
 * redirect, so the raw state value and its persisted hash cannot drift apart and
 * no caller can forget to persist one.
 *
 * @param store - State store that persists the hashed record.
 * @param input - Provider, redirect, tenant, return path, and scopes.
 * @returns The IdP redirect to send as a 302.
 * @throws OAuthFlowError when any input is unusable or capacity is exhausted.
 */
export async function begin_authorization(
  store: OAuthStateStore,
  input: BeginAuthorizationInput,
): Promise<AuthorizationRedirect> {
  const purpose: OAuthFlowPurpose = input.tenant_id === null ? "staff_login" : "calendar_consent";
  const pkce = generate_pkce_pair();
  const nonce = randomBytes(NONCE_ENTROPY_BYTES).toString("base64url");
  const issued = await store.issue({
    purpose,
    idp: input.idp,
    tenant_id: input.tenant_id,
    return_path: input.return_path,
    code_verifier: pkce.code_verifier,
    nonce,
  });
  return {
    authorization_url: build_authorize_url(input, issued.state, pkce.code_challenge, nonce),
    redirect_uri: input.redirect_uri,
  };
}

/**
 * Claim a callback, exchange the code, and verify the returned ID token.
 *
 * @param store - State store holding the claimed record.
 * @param exchanger - Provider code exchanger for this IdP.
 * @param id_token_options - ID-token verification settings for this IdP.
 * @param input - Expected provider, purpose, redirect, and callback parameters.
 * @returns The verified identity plus the provider tokens.
 * @throws OAuthFlowError for any state, code, exchange, or verification failure.
 */
export async function complete_authorization(
  store: OAuthStateStore,
  exchanger: AuthorizationCodeExchanger,
  id_token_options: IdTokenVerifierOptions,
  input: CompleteAuthorizationInput,
): Promise<CompletedAuthorization> {
  const record = await store.consume(input.params?.state);
  assert_flow_binding(record, input);
  require_return_path(record.return_path, input.allowed_return_paths);
  assert_provider_denial(input.params);
  const code = require_code(input.params?.code);
  const tokens = await exchange(exchanger, {
    client_id: require_client_id(input.client_id),
    client_secret: require_client_secret(input.client_secret),
    redirect_uri: input.redirect_uri,
    code,
    code_verifier: record.code_verifier,
  });
  const identity = await verify_staff_id_token(tokens.id_token, record.nonce, id_token_options);
  return { record, identity, tokens };
}

/**
 * Build the provider's authorize URL for the resolved state and PKCE material.
 *
 * @param input - Provider, client, redirect, and scopes.
 * @param state - Raw state value issued by the store.
 * @param code_challenge - S256 PKCE challenge.
 * @param nonce - Nonce bound into the state record and the ID token.
 * @returns Absolute authorize URL.
 * @throws OAuthFlowError when the provider or scopes are unsupported.
 */
function build_authorize_url(
  input: BeginAuthorizationInput,
  state: string,
  code_challenge: string,
  nonce: string,
): string {
  if (input.idp === "google") {
    return build_google_consent_url({
      client_id: input.client_id,
      redirect_uri: input.redirect_uri,
      scopes: input.scopes,
      state,
      code_challenge,
      nonce,
      offline_access: input.offline_access === true,
    });
  }
  return build_supabase_authorize_url({
    issuer_url: input.issuer_url,
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    scopes: input.scopes,
    state,
    code_challenge,
    nonce,
  });
}

/** Supabase Auth OAuth 2.1 authorize endpoint, derived from its issuer. */
function build_supabase_authorize_url(input: {
  issuer_url: string;
  client_id: string;
  redirect_uri: string;
  scopes: readonly string[];
  state: string;
  code_challenge: string;
  nonce: string;
}): string {
  const endpoint = new URL(`${require_https_issuer(input.issuer_url)}/oauth/authorize`);
  endpoint.searchParams.set("response_type", "code");
  endpoint.searchParams.set("client_id", input.client_id);
  endpoint.searchParams.set("redirect_uri", input.redirect_uri);
  endpoint.searchParams.set("scope", input.scopes.join(" "));
  endpoint.searchParams.set("state", input.state);
  endpoint.searchParams.set("code_challenge", input.code_challenge);
  endpoint.searchParams.set("code_challenge_method", "S256");
  endpoint.searchParams.set("nonce", input.nonce);
  return endpoint.toString();
}

/**
 * Require the claimed record to belong to this route's provider and purpose.
 *
 * @param record - State record claimed from the store.
 * @param input - Expected provider and purpose for this callback route.
 * @throws OAuthFlowError when the record was issued for a different flow.
 */
function assert_flow_binding(record: OAuthStateRecord, input: CompleteAuthorizationInput): void {
  if (record.idp !== input.idp) throw new OAuthFlowError("oauth_idp_unknown");
  if (record.purpose !== input.expected_purpose) throw new OAuthFlowError("oauth_state_unknown");
}

/**
 * Convert a provider denial into a sanitized failure.
 *
 * Checked only after the state claim, so a denial redirect cannot be used to
 * distinguish a valid state from an invalid one, and the provider's
 * `error_description` is deliberately not read.
 *
 * @param params - Untrusted callback parameters.
 * @throws OAuthFlowError when the provider reported an error.
 */
function assert_provider_denial(params: OAuthCallbackParams): void {
  if (typeof params?.error === "string" && params.error !== "") {
    throw new OAuthFlowError("oauth_identity_unverified");
  }
}

/** Run one code exchange, collapsing any provider failure. */
async function exchange(
  exchanger: AuthorizationCodeExchanger,
  input: {
    client_id: string;
    client_secret: string;
    redirect_uri: string;
    code: string;
    code_verifier: string;
  },
): Promise<AuthorizationCodeTokens> {
  if (exchanger === undefined || typeof exchanger.exchange !== "function") {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  try {
    return await exchanger.exchange(input);
  } catch {
    throw new OAuthFlowError("oauth_token_exchange_failed");
  }
}

/** Validate a callback authorization code without echoing it. */
function require_code(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CODE_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OAuthFlowError("oauth_token_exchange_failed");
  }
  return value;
}

/** Validate a client id supplied through the callback input. */
function require_client_id(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}

/** Validate a client secret supplied through the callback input. */
function require_client_secret(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}

/** Require an https issuer URL. */
function require_https_issuer(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return parsed.toString().replace(/\/$/u, "");
}
