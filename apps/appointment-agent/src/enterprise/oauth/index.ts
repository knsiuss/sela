/**
 * Barrel for the staff authentication boundary.
 *
 * Route handlers import from here so the module layout stays an implementation
 * detail. Nothing here reads process environment at import time; every entry
 * point takes its dependencies explicitly so a test never inherits ambient
 * configuration.
 */

export { OAuthFlowError, as_oauth_error } from "./oauth_error.js";
export type { OAuthFlowErrorCode } from "./oauth_error.js";
export {
  DEFAULT_OAUTH_STATE_TTL_SECONDS,
  InMemoryOAuthStateStore,
  MAX_OAUTH_STATE_TTL_SECONDS,
  OAuthStateMinter,
  hash_state,
  require_state_value,
} from "./oauth_state.js";
export type {
  IssueOAuthStateInput,
  IssuedOAuthState,
  OAuthFlowPurpose,
  OAuthStateRecord,
  OAuthStateStore,
  StaffIdentityProvider,
} from "./oauth_state.js";
export {
  DEFAULT_SOURCE_ADMISSION_POLICY,
  SOURCE_ADMISSION_ENV,
  SourceAdmissionLimiter,
  parse_source_admission_policy,
} from "./source_admission.js";
export type { SourceAdmissionDecision, SourceAdmissionPolicy } from "./source_admission.js";
export { PostgresOAuthStateStore } from "./postgres_oauth_state_store.js";
export type { PostgresOAuthStateStoreOptions } from "./postgres_oauth_state_store.js";
export { PKCE_CHALLENGE_METHOD, derive_code_challenge, generate_pkce_pair, verify_pkce_challenge } from "./pkce.js";
export type { PkcePair } from "./pkce.js";
export {
  assert_redirect_allowed,
  build_redirect_allow_list,
  require_configured_redirect,
  require_redirect_uri,
  require_return_path,
} from "./redirect_policy.js";
export {
  GOOGLE_TOKEN_ENDPOINT,
  google_code_exchanger,
  supabase_code_exchanger,
} from "./code_exchangers.js";
export { GOOGLE_AUTHORIZATION_ENDPOINT, build_google_consent_url } from "./google_authorize.js";
export type { GoogleConsentPrompt, GoogleConsentRequest } from "./google_authorize.js";
export type {
  AuthorizationCodeExchanger,
  AuthorizationCodeTokens,
  TokenEndpointAuthMethod,
} from "./code_exchangers.js";
export { verify_staff_id_token } from "./id_token_verifier.js";
export type { IdTokenVerifierOptions, VerifiedStaffIdentity } from "./id_token_verifier.js";
export {
  InMemoryStaffDirectory,
  STAFF_DIRECTORY_ENV,
  build_staff_principal,
  parse_staff_directory,
} from "./staff_directory.js";
export type { StaffDirectory, StaffTenantMembership } from "./staff_directory.js";
export {
  INSECURE_SESSION_COOKIE_NAME,
  MAX_SESSION_TTL_SECONDS,
  MIN_SESSION_TTL_SECONDS,
  SECURE_SESSION_COOKIE_NAME,
  hash_session_secret,
  issue_session_secret,
  parse_session_cookie,
  read_session_cookie_header,
  resolve_session_cookie_policy,
  secret_matches,
  select_session_cookie,
  serialize_session_cookie,
} from "./session_cookie.js";
export type { IssuedSessionSecret, SessionCookieConfig, SessionCookiePolicy } from "./session_cookie.js";
export {
  InMemoryStaffSessionStore,
  session_principal,
  staff_session_registry_id,
  staff_session_ttl_ms,
} from "./staff_session_store.js";
export type {
  CreateStaffSessionInput,
  EstablishedStaffSession,
  StaffSessionRecord,
  StaffSessionStore,
} from "./staff_session_store.js";
export { PostgresStaffSessionStore } from "./postgres_staff_session_store.js";
export type { PostgresStaffSessionStoreOptions } from "./postgres_staff_session_store.js";
export {
  InMemoryGoogleTokenGrantRepository,
  require_grant_tenant_id,
} from "./google_grant_repository.js";
export type { GoogleTokenGrant, GoogleTokenGrantRepository } from "./google_grant_repository.js";
export {
  REDIRECT_ALLOW_LIST_ENV,
  DEFAULT_CALENDAR_SCOPES,
  JWKS_CACHE_MS_ENV,
  TRUSTED_PROXY_HOPS_ENV,
  is_loopback_public_base_url,
  parse_staff_auth_config,
  require_provider,
} from "./staff_auth_config.js";
export type { IdProviderConfig, StaffAuthConfig } from "./staff_auth_config.js";
export { google_grant_revoker } from "./google_revocation.js";
export type { GoogleRevokerOptions } from "./google_revocation.js";
export { begin_authorization, complete_authorization } from "./oauth_flow.js";
export type {
  AuthorizationRedirect,
  BeginAuthorizationInput,
  CompleteAuthorizationInput,
  CompletedAuthorization,
  OAuthCallbackParams,
} from "./oauth_flow.js";
export {
  InMemoryOAuthAuditSink,
  as_secret_access_event,
  assert_redacted_oauth_event,
  outcome_for_error,
  record_oauth_event,
} from "./oauth_audit.js";
export type { OAuthAuditEvent, OAuthAuditOutcome, OAuthAuditRecord, OAuthAuditSink } from "./oauth_audit.js";
