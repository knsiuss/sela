/**
 * Server-only composition root for staff authentication.
 *
 * Everything the OAuth routes and the workspace layout need is built here, once
 * per process, from environment configuration. Two properties matter:
 *
 * - Nothing falls back to an unauthenticated mode. `runtime()` throws
 *   `oauth_configuration_invalid` when no provider is configured, so a local
 *   developer who has not configured an IdP gets a refusal, not an open
 *   dashboard.
 * - No browser input reaches this module. Tenant, role, and MFA come from a
 *   verified ID token and a directory lookup; the browser only ever supplies a
 *   `return_path` that is checked against a configuration allow-list.
 *
 * The in-memory state, session, and grant stores are correct for a single
 * process. Because they are, `runtime()` refuses to start when the configured
 * public origin is not loopback: a second instance would not see a login state,
 * a session revocation, or a grant revoke issued by the first. A multi-instance
 * deployment must inject shared adapters for the three ports, which is why they
 * are ports rather than module-level objects.
 *
 * This module imports `node:crypto` and reads the environment, so it must only
 * ever be imported from route handlers and Server Components. Next.js rejects the
 * import from a Client Component, which is the boundary this relies on.
 */

import { randomBytes } from "node:crypto";
import {
  InMemoryOAuthAuditSink,
  InMemoryOAuthStateStore,
  InMemoryStaffDirectory,
  InMemoryStaffSessionStore,
  OAuthFlowError,
  begin_authorization,
  build_staff_principal,
  complete_authorization,
  google_code_exchanger,
  google_grant_revoker,
  is_loopback_public_base_url,
  parse_session_cookie,
  parse_staff_auth_config,
  parse_staff_directory,
  require_provider,
  serialize_session_cookie,
  session_principal,
  supabase_code_exchanger,
  type IdProviderConfig,
  type OAuthCallbackParams,
  type OAuthStateStore,
  type StaffAuthConfig,
  type StaffSessionStore,
} from "appointment-agent/dist/src/enterprise/oauth/index.js";
import { GoogleTokenGrantStore } from "appointment-agent/dist/src/enterprise/google_token_grants.js";
import { create_signing_key_set } from "appointment-agent/dist/src/enterprise/oidc_verifier.js";
import type { SigningKeySet } from "appointment-agent/dist/src/enterprise/oidc_verifier.js";
import { create_tenant_secret_cipher } from "appointment-agent/dist/src/security/tenant_secret_cipher.js";
import { parse_recipient_key_ring } from "appointment-agent/dist/src/security/recipient_key_ring.js";
import type { AuthenticatedPrincipal, EnterpriseRole } from "appointment-agent/dist/src/enterprise/authorization.js";
import type { PrincipalClaims } from "@/domain/principal_claims";
import { to_wire_principal } from "@/domain/principal_claims";

/** Return paths a completed login may navigate to. */
export const DEFAULT_RETURN_PATHS: readonly string[] = ["/actions", "/audit"];

/** Scopes requested when authenticating staff (identity only, no API access). */
const LOGIN_SCOPES: readonly string[] = ["openid", "email", "profile"];

/** Everything the routes need, resolved once per process. */
export interface StaffAuthRuntime {
  config: StaffAuthConfig;
  state_store: OAuthStateStore;
  session_store: StaffSessionStore;
  directory: InMemoryStaffDirectory;
  grants: GoogleTokenGrantStore;
  audit: InMemoryOAuthAuditSink;
  /**
   * One signing-key cache per provider, held for the process lifetime so the
   * JWKS endpoint is fetched once per key rotation rather than once per login.
   */
  key_sets: ReadonlyMap<IdProviderConfig["idp"], SigningKeySet>;
}

let cached_runtime: StaffAuthRuntime | undefined;

/**
 * Resolve the process-wide staff authentication runtime.
 *
 * @param env - Environment mapping; defaults to the process environment.
 * @returns The cached runtime, built on first use.
 * @throws OAuthFlowError when staff authentication is not fully configured, or
 * when the in-memory stores below are combined with a public origin that is not
 * loopback.
 */
export function runtime(env: Record<string, string | undefined> = process.env): StaffAuthRuntime {
  if (cached_runtime !== undefined) return cached_runtime;
  const config = parse_staff_auth_config(env);
  // The state, session, and grant stores below are single-process, so a second
  // instance would not see a login state, a session revocation, or a grant
  // revoke issued by the first. Publishing that beyond loopback turns a
  // single-use control into a per-instance one, so it is refused at startup
  // rather than discovered during an incident. A shared adapter replaces these
  // three ports and removes the restriction.
  if (!is_loopback_public_base_url(config)) throw new OAuthFlowError("oauth_configuration_invalid");
  const ring = parse_recipient_key_ring(env);
  cached_runtime = {
    config,
    state_store: new InMemoryOAuthStateStore(),
    session_store: new InMemoryStaffSessionStore(),
    directory: parse_staff_directory(env["STAFF_DIRECTORY_JSON"]),
    grants: new GoogleTokenGrantStore(create_tenant_secret_cipher(ring), {
      sink: new InMemoryOAuthAuditSink(),
      // Without a revoker the store refuses to revoke, which would leave a
      // suspected leak with no way to un-mint the credential at the provider.
      revoke_upstream: google_grant_revoker(),
    }),
    audit: new InMemoryOAuthAuditSink(),
    key_sets: build_key_sets(config),
  };
  return cached_runtime;
}

/** Drop the cached runtime. Exposed so tests never inherit ambient config. */
export function reset_runtime(): void {
  cached_runtime = undefined;
}

/** Build one signing-key cache per configured provider. */
function build_key_sets(config: StaffAuthConfig): ReadonlyMap<IdProviderConfig["idp"], SigningKeySet> {
  const key_sets = new Map<IdProviderConfig["idp"], SigningKeySet>();
  for (const provider of config.providers) {
    key_sets.set(provider.idp, create_signing_key_set({
      issuer_url: provider.issuer_url,
      jwks_url: provider.jwks_url,
      audience: provider.staff_audience,
    }));
  }
  return key_sets;
}

/**
 * Build the authorize redirect for a staff login.
 *
 * @param parts - Resolved runtime.
 * @param idp - Provider the operator chose.
 * @param return_path - Browser-supplied destination, allow-listed here.
 * @returns The absolute IdP URL to redirect to.
 * @throws OAuthFlowError when the provider is disabled or the path is not allowed.
 */
export async function start_login(
  parts: StaffAuthRuntime,
  idp: "supabase" | "google",
  return_path: string,
): Promise<{ url: string }> {
  const provider = require_provider(parts.config, idp);
  const redirect = await begin_authorization(parts.state_store, {
    idp,
    issuer_url: provider.issuer_url,
    client_id: provider.client_id,
    redirect_uri: parts.config.login_redirect_uri,
    tenant_id: null,
    return_path,
    scopes: LOGIN_SCOPES,
  });
  return { url: redirect.authorization_url };
}

/**
 * Finish a staff login and establish the session cookie.
 *
 * @param parts - Resolved runtime.
 * @param idp - Provider whose callback this is.
 * @param params - Untrusted callback query parameters.
 * @param device_id - Opaque device identifier; only its hash is stored.
 * @returns The principal, the return path, and the `Set-Cookie` header value.
 * @throws OAuthFlowError when any control fails; no session is created then.
 */
export async function finish_login(
  parts: StaffAuthRuntime,
  idp: "supabase" | "google",
  params: OAuthCallbackParams,
  device_id: string,
): Promise<{ principal: AuthenticatedPrincipal; return_path: string; cookie: string }> {
  const provider = require_provider(parts.config, idp);
  const completed = await complete_authorization(
    parts.state_store,
    exchanger_for(provider),
    id_token_options(provider, require_key_set(parts, provider.idp)),
    {
      idp,
      expected_purpose: "staff_login",
      client_id: provider.client_id,
      client_secret: provider.client_secret,
      redirect_uri: parts.config.login_redirect_uri,
      params,
      allowed_return_paths: DEFAULT_RETURN_PATHS,
    },
  );
  const principal = await build_staff_principal({
    subject_id: completed.identity.subject_id,
    issuer: completed.identity.issuer,
    has_mfa: completed.identity.has_mfa,
    issued_at_iso: new Date().toISOString(),
  }, parts.directory);
  const session = await parts.session_store.create({
    subject_id: principal.subject_id,
    issuer: completed.identity.issuer,
    idp,
    has_mfa: principal.has_mfa,
    principal,
    device_id,
    ttl_seconds: parts.config.session_ttl_seconds,
  });
  return {
    principal,
    return_path: completed.record.return_path,
    cookie: serialize_session_cookie(parts.config.cookie, session.cookie_value),
  };
}

/**
 * Begin Calendar consent for one tenant the caller already belongs to.
 *
 * @param parts - Resolved runtime.
 * @param principal - Principal resolved from the session cookie.
 * @param tenant_id - Tenant whose calendar is being connected.
 * @returns The absolute Google consent URL.
 * @throws OAuthFlowError when Google is disabled or the caller lacks the tenant.
 */
export async function start_calendar_consent(
  parts: StaffAuthRuntime,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
): Promise<{ url: string }> {
  const provider = require_provider(parts.config, "google");
  const roles = principal.tenant_roles[tenant_id];
  if (roles === undefined || roles.length === 0) throw new OAuthFlowError("oauth_tenant_mismatch");
  const redirect = await begin_authorization(parts.state_store, {
    idp: "google",
    issuer_url: provider.issuer_url,
    client_id: provider.client_id,
    redirect_uri: parts.config.calendar_redirect_uri,
    tenant_id,
    return_path: "/actions",
    scopes: parts.config.calendar_scopes,
    // Offline access is what makes Google issue a durable refresh token.
    offline_access: true,
  });
  return { url: redirect.authorization_url };
}

/**
 * Finish Calendar consent and store the encrypted refresh token.
 *
 * @param parts - Resolved runtime.
 * @param principal - Principal resolved from the session cookie.
 * @param params - Untrusted callback query parameters.
 * @returns The tenant whose grant was stored.
 * @throws OAuthFlowError when the flow or the tenant binding fails.
 */
export async function finish_calendar_consent(
  parts: StaffAuthRuntime,
  principal: AuthenticatedPrincipal,
  params: OAuthCallbackParams,
): Promise<{ tenant_id: string }> {
  const provider = require_provider(parts.config, "google");
  const completed = await complete_authorization(
    parts.state_store,
    exchanger_for(provider),
    id_token_options(provider, require_key_set(parts, provider.idp)),
    {
      idp: "google",
      expected_purpose: "calendar_consent",
      client_id: provider.client_id,
      client_secret: provider.client_secret,
      redirect_uri: parts.config.calendar_redirect_uri,
      params,
      allowed_return_paths: DEFAULT_RETURN_PATHS,
    },
  );
  const tenant_id = completed.record.tenant_id;
  if (tenant_id === null) throw new OAuthFlowError("oauth_tenant_mismatch");
  // A consent callback must belong to the tenant the operator is signed in for;
  // otherwise a staff member could bind their own Google account to a tenant
  // they do not belong to by starting the flow from another one.
  if (principal.tenant_roles[tenant_id] === undefined) throw new OAuthFlowError("oauth_tenant_mismatch");
  const refresh_token = completed.tokens.refresh_token;
  if (refresh_token === undefined) {
    // Google omits a refresh token on re-consent unless the old grant was
    // revoked. Failing closed here is safer than silently believing we hold a
    // durable credential we do not have.
    throw new OAuthFlowError("oauth_token_exchange_failed");
  }
  await parts.grants.store({
    tenant_id,
    google_subject_id: completed.identity.subject_id,
    authorized_by_subject_id: principal.subject_id,
    scopes: completed.tokens.granted_scope === "" ? parts.config.calendar_scopes : completed.tokens.granted_scope.split(" "),
    refresh_token,
  });
  return { tenant_id };
}

/**
 * Resolve a session cookie into an authenticated principal.
 *
 * @param parts - Resolved runtime.
 * @param cookie_value - Raw `<id>.<secret>` cookie value.
 * @returns The principal the authorization contracts accept.
 * @throws OAuthFlowError when the session is absent, expired, or revoked.
 */
export async function principal_from_cookie(
  parts: StaffAuthRuntime,
  cookie_value: string | undefined,
): Promise<AuthenticatedPrincipal> {
  if (cookie_value === undefined || cookie_value === "") throw new OAuthFlowError("oauth_session_unavailable");
  const parsed = parse_session_cookie(cookie_value);
  return session_principal(await parts.session_store.resolve(`${parsed.session_id}.${parsed.secret}`));
}

/**
 * Revoke a tenant's Google Calendar grant on both sides.
 *
 * This is the entry point RB-15 names for a suspected credential leak. It
 * resolves nothing from the request and takes only the tenant id, because
 * destroying the local copy without Google's confirmation would leave the
 * provider-side credential live and the operator with nothing left to retry.
 *
 * @param parts - Resolved runtime.
 * @param tenant_id - Tenant whose grant is being withdrawn.
 * @returns True once Google has invalidated the grant and the local row is gone.
 * @throws OAuthFlowError when there is no grant, or when Google did not accept
 * the revoke. The grant stays stored and revocable in either failure case.
 */
export async function revoke_google_grant(parts: StaffAuthRuntime, tenant_id: string): Promise<boolean> {
  return parts.grants.revoke_google_grant(tenant_id);
}

/**
 * Revoke a session and return the cookie that clears it.
 *
 * @param parts - Resolved runtime.
 * @param cookie_value - Raw cookie value from the request.
 * @returns A `Set-Cookie` value that removes the session cookie.
 */
export async function revoke_session(
  parts: StaffAuthRuntime,
  cookie_value: string | undefined,
): Promise<string> {
  if (cookie_value !== undefined && cookie_value !== "") {
    try {
      await parts.session_store.revoke_by_cookie(cookie_value);
    } catch {
      // A logout for an already-unknown session still clears the cookie; the
      // operator's intent is satisfied either way.
    }
  }
  return serialize_session_cookie(parts.config.cookie, "", { clear: true });
}

/** Claims for the client workspace, projected through the wire boundary. */
export function claims_for(principal: AuthenticatedPrincipal): PrincipalClaims {
  return to_wire_principal(principal);
}

/** Lowest tenant id a principal may act in; deterministic workspace scope. */
export function workspace_tenant(principal: AuthenticatedPrincipal): string {
  const tenants = Object.keys(principal.tenant_roles).sort();
  const first = tenants[0];
  if (first === undefined) throw new OAuthFlowError("oauth_membership_unresolved");
  return first;
}

/** Highest-privilege role a principal holds in a tenant, for UI hints. */
export function workspace_role(principal: AuthenticatedPrincipal, tenant_id: string): EnterpriseRole {
  const order: readonly EnterpriseRole[] = ["owner", "admin", "developer", "operator", "support", "analyst"];
  const roles = principal.tenant_roles[tenant_id] ?? [];
  for (const candidate of order) {
    if (roles.includes(candidate)) return candidate;
  }
  throw new OAuthFlowError("oauth_membership_unresolved");
}

/** Select the code exchanger for a provider. */
function exchanger_for(provider: IdProviderConfig) {
  return provider.idp === "google"
    ? google_code_exchanger()
    : supabase_code_exchanger(provider.issuer_url, { auth_method: "client_secret_basic" });
}

/** Require the provider's long-lived signing-key cache. */
function require_key_set(parts: StaffAuthRuntime, idp: IdProviderConfig["idp"]): SigningKeySet {
  const key_set = parts.key_sets.get(idp);
  if (key_set === undefined) throw new OAuthFlowError("oauth_configuration_invalid");
  return key_set;
}

/** Build ID-token verification options for a provider. */
function id_token_options(provider: IdProviderConfig, key_set: SigningKeySet) {
  return {
    issuer_url: provider.issuer_url,
    jwks_url: provider.jwks_url,
    staff_audience: provider.staff_audience,
    key_set,
    ...(provider.hosted_domain === undefined ? {} : { expected_hosted_domain: provider.hosted_domain }),
  };
}

/** Opaque per-request device identifier; the raw value is never persisted. */
export function new_device_id(): string {
  return randomBytes(16).toString("base64url");
}
