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
} from "./oauth_state.js";
export type {
  IssueOAuthStateInput,
  IssuedOAuthState,
  OAuthFlowPurpose,
  OAuthStateRecord,
  OAuthStateStore,
  StaffIdentityProvider,
} from "./oauth_state.js";
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
  assert_principal_tenant,
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
  resolve_session_cookie_policy,
  secret_matches,
  serialize_session_cookie,
} from "./session_cookie.js";
export type { IssuedSessionSecret, SessionCookieConfig, SessionCookiePolicy } from "./session_cookie.js";
export { InMemoryStaffSessionStore, session_device_hash, session_principal } from "./staff_session_store.js";
export type {
  CreateStaffSessionInput,
  EstablishedStaffSession,
  StaffSessionRecord,
  StaffSessionStore,
} from "./staff_session_store.js";
export {
  REDIRECT_ALLOW_LIST_ENV,
  DEFAULT_CALENDAR_SCOPES,
  parse_staff_auth_config,
  require_provider,
} from "./staff_auth_config.js";
export type { IdProviderConfig, StaffAuthConfig } from "./staff_auth_config.js";
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