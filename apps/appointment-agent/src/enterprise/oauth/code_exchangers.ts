/**
 * Authorization-code to token exchange for both staff identity providers.
 *
 * Both providers speak the same RFC 6749 code exchange with PKCE; only the token
 * endpoint and the client-authentication style differ. Modelling that as one port
 * means the exchange is written, bounded, and tested once, and a new provider
 * cannot be added with a subtly different exchange.
 *
 * Verified against each provider's published documentation:
 *
 * - Supabase Auth's OAuth 2.1 token endpoint is `<issuer>/oauth/token` and
 *   accepts `client_secret_post` or `client_secret_basic`.
 * - Google's endpoint is `https://oauth2.googleapis.com/token` with the same two
 *   client-authentication styles. Google omits `refresh_token` on a re-consent
 *   unless the previous grant was revoked, so an absent refresh token is a normal
 *   outcome that callers must handle rather than treat as a failure.
 *
 * The module deliberately has no provider-package import: the staff-auth modules
 * are also consumed by the dashboard's bundler, which cannot follow the Calendar
 * package's NodeNext source specifiers.
 */

import { OAuthFlowError } from "./oauth_error.js";

/** Client authentication style accepted by both providers. */
export type TokenEndpointAuthMethod = "client_secret_post" | "client_secret_basic";

/** Google's OAuth 2.0 token endpoint. */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Tokens returned by a successful authorization-code exchange. */
export interface AuthorizationCodeTokens {
  /** OIDC ID token; required because staff identity is established from it. */
  id_token: string;
  access_token: string;
  /** Absent when the provider reuses an existing grant. */
  refresh_token: string | undefined;
  granted_scope: string;
}

/** Input for one code exchange. */
export interface CodeExchangeInput {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  code: string;
  code_verifier: string;
}

/** Port implemented once per provider. */
export interface AuthorizationCodeExchanger {
  /** Exchange one authorization code for tokens using PKCE. */
  exchange(input: CodeExchangeInput): Promise<AuthorizationCodeTokens>;
}

/** Minimal fetch shape replaceable by a test double. */
export type TokenFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_FIELD_CHARS = 4096;

/**
 * Build the Supabase Auth authorization-code exchanger.
 *
 * @param issuer_url - Supabase Auth issuer, for example `https://x.supabase.co/auth/v1`.
 * @param options - Optional client auth method, fetch, and timeout.
 * @returns An exchanger bound to `<issuer>/oauth/token`.
 * @throws OAuthFlowError when the issuer is not an https URL.
 */
export function supabase_code_exchanger(
  issuer_url: string,
  options: { auth_method?: TokenEndpointAuthMethod; fetch?: TokenFetch; timeout_ms?: number } = {},
): AuthorizationCodeExchanger {
  return form_exchanger(
    `${require_https_url(issuer_url, "supabase issuer")}/oauth/token`,
    options.auth_method ?? "client_secret_basic",
    options.fetch,
    options.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  );
}

/**
 * Build the Google authorization-code exchanger.
 *
 * @param options - Optional fetch and timeout.
 * @returns An exchanger for Google's documented token endpoint.
 */
export function google_code_exchanger(
  options: { auth_method?: TokenEndpointAuthMethod; fetch?: TokenFetch; timeout_ms?: number } = {},
): AuthorizationCodeExchanger {
  return form_exchanger(
    GOOGLE_TOKEN_ENDPOINT,
    options.auth_method ?? "client_secret_post",
    options.fetch,
    options.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  );
}

/** Shared form-encoded code exchange with bounded client authentication. */
function form_exchanger(
  token_endpoint: string,
  auth_method: TokenEndpointAuthMethod,
  fetch_implementation: TokenFetch | undefined,
  timeout_ms: number,
): AuthorizationCodeExchanger {
  const do_fetch = fetch_implementation ?? globalThis.fetch;
  if (typeof do_fetch !== "function") throw new OAuthFlowError("oauth_configuration_invalid");
  return {
    async exchange(input: CodeExchangeInput): Promise<AuthorizationCodeTokens> {
      const client_id = require_field(input?.client_id, "client_id");
      const client_secret = require_field(input?.client_secret, "client_secret");
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: require_field(input?.code, "code"),
        code_verifier: require_verifier(input?.code_verifier),
        redirect_uri: require_field(input?.redirect_uri, "redirect_uri"),
      });
      if (auth_method === "client_secret_post") {
        body.set("client_id", client_id);
        body.set("client_secret", client_secret);
      }
      return read_tokens(await post_form(token_endpoint, body, do_fetch, auth_method, client_id, client_secret, timeout_ms));
    },
  };
}

/** POST a form body with optional HTTP Basic client authentication. */
async function post_form(
  endpoint: string,
  body: URLSearchParams,
  fetch_implementation: TokenFetch,
  auth_method: TokenEndpointAuthMethod,
  client_id: string,
  client_secret: string,
  timeout_ms: number,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (auth_method === "client_secret_basic") {
    headers.Authorization = `Basic ${Buffer.from(`${client_id}:${client_secret}`, "utf8").toString("base64")}`;
  }
  let response: Response;
  try {
    response = await fetch_implementation(endpoint, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(timeout_ms),
    });
  } catch (error) {
    throw new OAuthFlowError(is_timeout_error(error) ? "oauth_configuration_invalid" : "oauth_token_exchange_failed");
  }
  if (!response.ok) throw new OAuthFlowError("oauth_token_exchange_failed");
  return response;
}

/**
 * Read and bound a token response without echoing any token value.
 *
 * A missing `id_token` is a hard failure rather than a reason to fall back to the
 * access token: the ID token is the only one that carries the nonce this flow
 * bound, so accepting an access token instead would drop the replay control.
 *
 * @param response - Successful token endpoint response.
 * @returns The validated token set.
 * @throws OAuthFlowError when the body is unusable.
 */
async function read_tokens(response: Response): Promise<AuthorizationCodeTokens> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new OAuthFlowError("oauth_token_exchange_failed");
  }
  if (text.length === 0 || text.length > MAX_RESPONSE_BYTES) {
    throw new OAuthFlowError("oauth_token_exchange_failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OAuthFlowError("oauth_token_exchange_failed");
  }
  if (!is_record(parsed)) throw new OAuthFlowError("oauth_token_exchange_failed");
  if (typeof parsed["id_token"] !== "string" || parsed["id_token"].length === 0) {
    throw new OAuthFlowError("oauth_identity_unverified");
  }
  if (typeof parsed["access_token"] !== "string" || parsed["access_token"].length === 0) {
    throw new OAuthFlowError("oauth_token_exchange_failed");
  }
  const refresh_token = parsed["refresh_token"];
  return {
    id_token: parsed["id_token"],
    access_token: parsed["access_token"],
    refresh_token: typeof refresh_token === "string" && refresh_token.length > 0 ? refresh_token : undefined,
    granted_scope: typeof parsed["scope"] === "string" ? parsed["scope"] : "",
  };
}

/** Require an https URL with no credentials, query, or fragment. */
function require_https_url(value: string, field_name: string): string {
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
  void field_name;
  return parsed.toString().replace(/\/$/u, "");
}

/** Require a bounded, trimmed form field. */
function require_field(value: string, field_name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD_CHARS || value.trim() !== value) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  void field_name;
  return value;
}

/** Require an RFC 7636 code verifier. */
function require_verifier(value: string): string {
  if (typeof value !== "string" || value.length < 43 || value.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new OAuthFlowError("oauth_pkce_invalid");
  }
  return value;
}

function is_timeout_error(error: unknown): boolean {
  if (!is_record(error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}