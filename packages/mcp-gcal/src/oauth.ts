const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_EXPIRY_LEEWAY_SECONDS = 30;
const MINIMUM_USABLE_EXPIRY_SECONDS = 1;

/** Typed, secret-safe failures from the OAuth token exchange. */
export type GoogleOAuthErrorCode =
  | "configuration_error"
  | "request_timeout"
  | "request_failed"
  | "invalid_response"
  | "upstream_error";

/** Error raised without including credentials or an upstream response body. */
export class GoogleOAuthError extends Error {
  readonly code: GoogleOAuthErrorCode;
  readonly status: number | undefined;
  readonly code_upstream: string | undefined;

  constructor(
    code: GoogleOAuthErrorCode,
    message: string,
    status?: number,
    code_upstream?: string,
  ) {
    super(message);
    this.name = "GoogleOAuthError";
    this.code = code;
    this.status = status;
    this.code_upstream = code_upstream;
  }
}

/** Minimal fetch shape that can be replaced by a test double. */
export type OAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Credentials and injectable behavior for one OAuth client. */
export interface GoogleOAuthClientOptions {
  client_id: string;
  client_secret: string;
  token_key?: string;
  refresh_token?: string;
  refresh_token_provider?: (token_key: string) => string | Promise<string>;
  fetch?: OAuthFetch;
  clock?: () => number;
  request_timeout_ms?: number;
  expiry_leeway_seconds?: number;
}

/** Credentials used for a tenant token lookup. */
export interface GoogleOAuthTokenInput {
  token_key: string;
  refresh_token?: string;
}

interface CachedAccessToken {
  value: string;
  expires_at_ms: number;
}

interface OAuthTokenResponse {
  access_token: string;
  expires_in_seconds: number;
}

/**
 * Refreshes Google access tokens from tenant-scoped refresh-token secrets.
 *
 * Access tokens are accepted only as responses from the OAuth endpoint and are
 * kept in memory. They are never accepted as configuration, logged, or placed
 * in an error message. Concurrent requests for one token key share one refresh.
 */
export class GoogleOAuthClient {
  private readonly client_id: string;
  private readonly client_secret: string;
  private readonly configured_token_key: string | undefined;
  private readonly configured_refresh_token: string | undefined;
  private readonly refresh_token_provider:
    | ((token_key: string) => string | Promise<string>)
    | undefined;
  private readonly fetch_implementation: OAuthFetch;
  private readonly clock: () => number;
  private readonly request_timeout_ms: number;
  private readonly expiry_leeway_seconds: number;
  private readonly access_token_cache = new Map<string, CachedAccessToken>();
  private readonly refresh_in_flight = new Map<string, Promise<string>>();

  constructor(options: GoogleOAuthClientOptions) {
    this.client_id = require_text(options.client_id, "client_id");
    this.client_secret = require_text(options.client_secret, "client_secret");
    this.configured_token_key = optional_text(options.token_key, "token_key");
    this.configured_refresh_token = optional_text(options.refresh_token, "refresh_token");
    this.refresh_token_provider = options.refresh_token_provider;
    this.fetch_implementation = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? (() => Date.now());
    this.request_timeout_ms = positive_integer(
      options.request_timeout_ms,
      "request_timeout_ms",
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.expiry_leeway_seconds = non_negative_integer(
      options.expiry_leeway_seconds,
      "expiry_leeway_seconds",
      DEFAULT_EXPIRY_LEEWAY_SECONDS,
    );
  }

  /**
   * Return a valid access token for a configured or supplied tenant key.
   *
   * A refresh is not retried automatically. A failed refresh rejects all
   * callers sharing that in-flight request and leaves no cached token behind.
   *
   * @param input - Optional tenant token key or credential override.
   * @returns The access token from the OAuth response or in-memory cache.
   * @throws GoogleOAuthError for missing secrets, network failures, timeouts,
   * invalid responses, or upstream token errors.
   */
  async get_access_token(input?: string | GoogleOAuthTokenInput): Promise<string> {
    const credential = await this.resolve_credential(input);
    const cached_token = this.access_token_cache.get(credential.token_key);
    if (cached_token !== undefined && cached_token.expires_at_ms > this.clock()) {
      return cached_token.value;
    }

    const in_flight = this.refresh_in_flight.get(credential.token_key);
    if (in_flight !== undefined) return in_flight;

    const refresh = this.refresh_access_token(credential.token_key, credential.refresh_token)
      .finally(() => this.refresh_in_flight.delete(credential.token_key));
    this.refresh_in_flight.set(credential.token_key, refresh);
    return refresh;
  }

  private async resolve_credential(input?: string | GoogleOAuthTokenInput): Promise<{
    token_key: string;
    refresh_token: string;
  }> {
    const supplied = typeof input === "string" ? { token_key: input } : input;
    const token_key = optional_text(supplied?.token_key ?? this.configured_token_key, "token_key");
    if (token_key === undefined) {
      throw new GoogleOAuthError("configuration_error", "a token key is required");
    }
    const configured_refresh_token = supplied?.refresh_token ?? this.configured_refresh_token;
    const refresh_token = configured_refresh_token ?? await this.lookup_refresh_token(token_key);
    if (refresh_token === undefined) {
      throw new GoogleOAuthError(
        "configuration_error",
        "a refresh token is not configured for this tenant",
      );
    }
    return { token_key, refresh_token: require_text(refresh_token, "refresh_token") };
  }

  private async lookup_refresh_token(token_key: string): Promise<string | undefined> {
    if (this.refresh_token_provider === undefined) return undefined;
    try {
      return await this.refresh_token_provider(token_key);
    } catch {
      throw new GoogleOAuthError("configuration_error", "refresh token provider failed");
    }
  }

  private async refresh_access_token(token_key: string, refresh_token: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.client_id,
      client_secret: this.client_secret,
      grant_type: "refresh_token",
      refresh_token,
    });
    let response: Response;
    try {
      response = await this.fetch_implementation(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.request_timeout_ms),
      });
    } catch (error) {
      if (is_timeout_error(error)) {
        throw new GoogleOAuthError("request_timeout", "OAuth refresh request timed out");
      }
      throw new GoogleOAuthError(
        "request_failed",
        "OAuth refresh request failed before a response was received",
      );
    }

    if (!response.ok) {
      const code_upstream = await read_upstream_code(response);
      throw new GoogleOAuthError(
        "upstream_error",
        `OAuth refresh failed with status ${response.status}`,
        response.status,
        code_upstream,
      );
    }

    const token_response = await read_token_response(response);
    const usable_seconds = token_response.expires_in_seconds - this.expiry_leeway_seconds;
    if (usable_seconds < MINIMUM_USABLE_EXPIRY_SECONDS) {
      throw new GoogleOAuthError("invalid_response", "OAuth access token lifetime is too short");
    }
    this.access_token_cache.set(token_key, {
      value: token_response.access_token,
      expires_at_ms: this.clock() + usable_seconds * 1000,
    });
    return token_response.access_token;
  }
}

async function read_token_response(response: Response): Promise<OAuthTokenResponse> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GoogleOAuthError("invalid_response", "OAuth refresh response was not valid JSON");
  }
  if (
    !is_record(payload) ||
    typeof payload.access_token !== "string" ||
    payload.access_token.trim() === "" ||
    typeof payload.expires_in !== "number" ||
    !Number.isFinite(payload.expires_in) ||
    payload.expires_in <= 0
  ) {
    throw new GoogleOAuthError("invalid_response", "OAuth refresh response was invalid");
  }
  return { access_token: payload.access_token, expires_in_seconds: payload.expires_in };
}

async function read_upstream_code(response: Response): Promise<string | undefined> {
  try {
    const payload: unknown = await response.json();
    if (!is_record(payload) || !is_record(payload.error)) return undefined;
    const error = payload.error;
    if (typeof error.status === "string" && is_safe_upstream_code(error.status)) return error.status;
    if (typeof error.reason === "string" && is_safe_upstream_code(error.reason)) return error.reason;
    if (typeof error.code === "string" && is_safe_upstream_code(error.code)) return error.code;
    if (typeof error.code === "number" && Number.isSafeInteger(error.code)) return String(error.code);
    if (typeof error.status === "number" && Number.isSafeInteger(error.status)) return String(error.status);
  } catch {
    return undefined;
  }
  return undefined;
}

function require_text(value: string, field_name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GoogleOAuthError("configuration_error", `${field_name} must not be empty`);
  }
  return value;
}

function optional_text(value: string | undefined, field_name: string): string | undefined {
  if (value === undefined) return undefined;
  return require_text(value, field_name);
}

function positive_integer(
  value: number | undefined,
  field_name: string,
  default_value: number,
): number {
  if (value === undefined) return default_value;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GoogleOAuthError("configuration_error", `${field_name} must be a positive integer`);
  }
  return value;
}

function non_negative_integer(
  value: number | undefined,
  field_name: string,
  default_value: number,
): number {
  if (value === undefined) return default_value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GoogleOAuthError("configuration_error", `${field_name} must be a non-negative integer`);
  }
  return value;
}

function is_timeout_error(error: unknown): boolean {
  if (!is_record(error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function is_safe_upstream_code(value: string): boolean {
  return value.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(value);
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
