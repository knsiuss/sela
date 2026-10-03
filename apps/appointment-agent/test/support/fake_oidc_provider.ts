/**
 * A local fake identity provider for staff-login tests.
 *
 * It signs real RS256 ID tokens, publishes a real JWKS over an injected fetch,
 * and enforces PKCE exactly the way a correct provider must: it recomputes the
 * challenge from the verifier and refuses a mismatch. That is what makes the
 * round-trip tests evidence rather than a tautology — a flow that skipped PKCE
 * would fail against this provider.
 *
 * Nothing here reaches the network, and no credential is logged.
 */

import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/** Issuer the fake provider claims, matching a valid https origin. */
export const FAKE_ISSUER = "https://idp.test.invalid/auth/v1";

/** JWKS URL the fake provider serves. */
export const FAKE_JWKS_URL = "https://idp.test.invalid/auth/v1/jwks";

/** Staff audience the fake provider issues for. */
export const FAKE_AUDIENCE = "fake-client-id";

/** Subject the fake provider authenticates. */
export const FAKE_SUBJECT = "staff-subject-1";

/** Tenant the fake provider's subject is a member of. */
export const FAKE_TENANT_ID = "1001";

/** The only authorization code the fake provider will honour. */
export const FAKE_CODE = "fake-authorization-code";

/** Provider response options for one test. */
export interface FakeIdpOptions {
  nonce?: string;
  email_verified?: boolean;
  /** Supabase-style object `amr`; omit to use a string `amr` of `["pwd"]`. */
  supabase_amr?: boolean;
  mfa?: boolean;
  hosted_domain?: string;
  /** Override the issued subject, for negative membership tests. */
  subject?: string;
  /** Extra claims merged into the ID token. */
  extra_claims?: Record<string, unknown>;
  /** Omit the id_token from the token response. */
  omit_id_token?: boolean;
  /** Fail the token endpoint instead of issuing tokens. */
  fail_token_endpoint?: boolean;
  /** Accept any code_verifier, to prove the tests detect a missing PKCE check. */
  ignore_pkce?: boolean;
}

/** A configured fake provider. */
export interface FakeIdp {
  issuer: string;
  jwks_url: string;
  audience: string;
  subject: string;
  /** Signed an ID token for the given nonce. */
  issue_id_token(nonce: string | undefined, options?: FakeIdpOptions): string;
  /** Fetch double serving the JWKS and the OAuth token endpoint. */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Number of successful code exchanges; proves single-use enforcement. */
  readonly exchange_count: number;
  /** Nonce the provider last echoed, for assertions. */
  readonly last_nonce: string | undefined;
  /** Record the authorize request the provider "served", so it can police PKCE. */
  record_authorize_request(nonce: string | undefined, code_challenge?: string): void;
}

let cached_keys: { private_key: KeyObject; public_jwk: Record<string, unknown> } | undefined;

/** Generate one RSA key pair reused across tests to keep them fast. */
function signing_keys(): { private_key: KeyObject; public_jwk: Record<string, unknown> } {
  if (cached_keys === undefined) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    cached_keys = {
      private_key: pair.privateKey,
      public_jwk: pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>,
    };
  }
  return cached_keys;
}

/** Base64url encode a JSON value. */
function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Build a fake provider with its own key pair, JWKS, and token endpoint.
 *
 * @param defaults - Options applied to every issued token.
 * @returns The configured provider.
 */
export function create_fake_idp(defaults: FakeIdpOptions = {}): FakeIdp {
  const keys = signing_keys();
  let exchange_count = 0;
  let last_nonce: string | undefined;
  // The provider echoes the nonce from its own authorize request and holds the
  // challenge it issued, so a test must replay what the flow put in the URL.
  let nonce_seen_by_provider: string | undefined;
  const recorded_challenges = new Map<string, string>();
  const spent_codes = new Set<string>();

  const issue_id_token = (nonce: string | undefined, options: FakeIdpOptions = {}): string => {
    const settings = { ...defaults, ...options };
    const now_seconds = Math.floor(Date.now() / 1_000);
    const claims: Record<string, unknown> = {
      iss: FAKE_ISSUER,
      aud: FAKE_AUDIENCE,
      sub: settings.subject ?? FAKE_SUBJECT,
      iat: now_seconds,
      exp: now_seconds + 300,
      ...(nonce === undefined ? {} : { nonce }),
      email_verified: settings.email_verified ?? true,
      ...mfa_claims(settings),
      ...(settings.hosted_domain === undefined ? {} : { hd: settings.hosted_domain }),
      ...(settings.extra_claims ?? {}),
    };
    const header = base64url(JSON.stringify({ alg: "RS256", kid: "fake-key", typ: "JWT" }));
    const payload = base64url(JSON.stringify(claims));
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.private_key).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };

  const fetch_double = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === FAKE_JWKS_URL) {
      return new Response(JSON.stringify({ keys: [{ ...keys.public_jwk, kid: "fake-key", alg: "RS256", use: "sig" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Supabase's endpoint is `<issuer>/oauth/token`; Google's is `/token`.
    if (url.endsWith("/oauth/token") || url.endsWith("/token")) return token_endpoint(init);
    throw new Error(`fake-provider-reached-unexpected-endpoint:${url}`);
  };

  /** Serve one token-endpoint call with strict PKCE and single-use codes. */
  const token_endpoint = async (init?: RequestInit): Promise<Response> => {
    const settings = { ...defaults };
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (settings.fail_token_endpoint === true) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    const code = form.get("code") ?? "";
    const code_verifier = form.get("code_verifier") ?? "";
    // `URLSearchParams.get` yields null when absent, so the challenge recorded
    // from the authorize request is compared only when the flow actually sent
    // one; otherwise PKCE cannot be enforced.
    const challenge = recorded_challenges.get(code);
    if (code === "" || code !== FAKE_CODE || spent_codes.has(code)) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    if (settings.ignore_pkce !== true && challenge !== undefined) {
      const derived = createHash("sha256").update(code_verifier, "ascii").digest("base64url");
      if (derived !== challenge) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    if (code_verifier.length < 43) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    spent_codes.add(code);
    exchange_count += 1;
    last_nonce = nonce_seen_by_provider;
    return new Response(JSON.stringify({
      access_token: "fake-access-token",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "fake-refresh-token",
      scope: "openid email",
      ...(settings.omit_id_token === true ? {} : { id_token: issue_id_token(nonce_seen_by_provider) }),
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  return {
    issuer: FAKE_ISSUER,
    jwks_url: FAKE_JWKS_URL,
    audience: FAKE_AUDIENCE,
    subject: FAKE_SUBJECT,
    issue_id_token,
    fetch: fetch_double,
    record_authorize_request(nonce: string | undefined, code_challenge?: string): void {
      nonce_seen_by_provider = nonce;
      if (code_challenge !== undefined) recorded_challenges.set(FAKE_CODE, code_challenge);
    },
    get exchange_count(): number {
      return exchange_count;
    },
    get last_nonce(): string | undefined {
      return last_nonce;
    },
  };
}

/** Build the MFA claims in the shape the chosen provider emits. */
function mfa_claims(options: FakeIdpOptions): Record<string, unknown> {
  if (options.mfa !== true) {
    return options.supabase_amr === true
      ? { aal: "aal1", amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1_000) }] }
      : { amr: ["pwd"] };
  }
  return options.supabase_amr === true
    ? { aal: "aal2", amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1_000) }] }
    : { amr: ["pwd", "otp"] };
}

/** Read the nonce a flow put in an authorize URL, as a provider would. */
export function nonce_in_authorize_url(authorization_url: string): string {
  return new URL(authorization_url).searchParams.get("nonce") ?? "";
}

/** Read the PKCE challenge a flow put in an authorize URL. */
export function challenge_in_authorize_url(authorization_url: string): string {
  return new URL(authorization_url).searchParams.get("code_challenge") ?? "";
}

/** Read the state a flow put in an authorize URL. */
export function state_in_authorize_url(authorization_url: string): string {
  return new URL(authorization_url).searchParams.get("state") ?? "";
}