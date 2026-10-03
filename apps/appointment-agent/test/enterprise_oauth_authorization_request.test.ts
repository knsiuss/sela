/**
 * Coverage for the Google authorization request and both code exchangers.
 *
 * Endpoint values are asserted against Google's published OAuth 2.0 server
 * metadata, and the error assertions matter because a code exchange sits on the
 * login path: a failure message must name the status without ever repeating the
 * authorization code, PKCE verifier, or client secret.
 */

import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  build_google_consent_url,
  google_code_exchanger,
  supabase_code_exchanger,
} from "../src/enterprise/oauth/index.js";
import { OAuthFlowError } from "../src/enterprise/oauth/oauth_error.js";

const CODE = "4/P7q7W91a-oMsCeLvIaQm6bTrgtp7";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-extra";
const REDIRECT_URI = "https://staff.example.com/auth/google/callback";

function consent_request() {
  return {
    client_id: "client-id.apps.googleusercontent.com",
    redirect_uri: REDIRECT_URI,
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    state: "state-value",
    code_challenge: CHALLENGE,
    nonce: "nonce-value",
    offline_access: true,
  };
}

function json_response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function exchange_input() {
  return {
    client_id: "client-id.apps.googleusercontent.com",
    client_secret: "client-secret",
    redirect_uri: REDIRECT_URI,
    code: CODE,
    code_verifier: VERIFIER,
  };
}

describe("Google endpoints match published metadata", () => {
  it("uses the documented authorization and token endpoints", () => {
    expect(GOOGLE_AUTHORIZATION_ENDPOINT).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(GOOGLE_TOKEN_ENDPOINT).toBe("https://oauth2.googleapis.com/token");
  });
});

describe("Google consent redirect", () => {
  it("carries PKCE S256, state, nonce, and offline access", () => {
    const url = new URL(build_google_consent_url(consent_request()));
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("nonce")).toBe("nonce-value");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  it("omits offline access when it was not requested", () => {
    const url = new URL(build_google_consent_url({ ...consent_request(), offline_access: false }));
    expect(url.searchParams.get("access_type")).toBeNull();
  });

  it("de-duplicates and joins scopes with single spaces", () => {
    const url = new URL(build_google_consent_url({ ...consent_request(), scopes: ["scope.a", "scope.b", "scope.a"] }));
    expect(url.searchParams.get("scope")).toBe("scope.a scope.b");
  });

  it("refuses a plain or malformed code challenge rather than downgrading", () => {
    expect(() => build_google_consent_url({ ...consent_request(), code_challenge: "short" })).toThrow(OAuthFlowError);
    expect(() => build_google_consent_url({ ...consent_request(), code_challenge: `${VERIFIER}=` })).toThrow(OAuthFlowError);
    expect(() => build_google_consent_url({ ...consent_request(), code_challenge: `${"a".repeat(42)}+` })).toThrow(OAuthFlowError);
  });

  it("refuses a non-https redirect that is not loopback", () => {
    expect(() => build_google_consent_url({ ...consent_request(), redirect_uri: "http://staff.example.com/cb" }))
      .toThrow(OAuthFlowError);
    expect(build_google_consent_url({ ...consent_request(), redirect_uri: "http://127.0.0.1:3000/cb" })).toContain("127.0.0.1");
  });

  it("refuses an empty scope list and an unknown prompt value", () => {
    expect(() => build_google_consent_url({ ...consent_request(), scopes: [] })).toThrow(OAuthFlowError);
    expect(() => build_google_consent_url({ ...consent_request(), prompt: "always" as never })).toThrow(OAuthFlowError);
  });
});

describe("Google authorization-code exchange", () => {
  it("sends the documented form fields including the PKCE verifier", async () => {
    const fetch_mock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe(CODE);
      expect(body.get("code_verifier")).toBe(VERIFIER);
      expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(body.get("client_id")).toBe("client-id.apps.googleusercontent.com");
      expect(body.get("client_secret")).toBe("client-secret");
      return json_response({
        access_token: "ya29.access-token",
        expires_in: 3599,
        refresh_token: "1//refresh-token",
        scope: "https://www.googleapis.com/auth/calendar.events",
        id_token: "id-token-value",
      });
    });
    const result = await google_code_exchanger({ fetch: fetch_mock }).exchange(exchange_input());
    expect(fetch_mock.mock.calls[0]?.[0]).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(result.access_token).toBe("ya29.access-token");
    expect(result.refresh_token).toBe("1//refresh-token");
    expect(result.id_token).toBe("id-token-value");
  });

  it("treats an absent refresh token as a normal re-consent outcome", async () => {
    const result = await google_code_exchanger({
      fetch: vi.fn(async () => json_response({ access_token: "ya29.a", expires_in: 10, scope: "", id_token: "id" })),
    }).exchange(exchange_input());
    expect(result.refresh_token).toBeUndefined();
  });

  it("fails closed when the response carries no ID token", async () => {
    // The ID token is the only credential that carries the flow's nonce, so an
    // access token must not be accepted in its place.
    const attempt = google_code_exchanger({
      fetch: vi.fn(async () => json_response({ access_token: "ya29.a", expires_in: 10 })),
    }).exchange(exchange_input());
    await expect(attempt).rejects.toMatchObject({ code: "oauth_identity_unverified" });
  });

  it("collapses an upstream rejection without echoing code, verifier, or secret", async () => {
    const attempt = google_code_exchanger({
      fetch: vi.fn(async () => json_response({ error: "invalid_grant" }, 400)),
    }).exchange({ ...exchange_input(), client_secret: "super-secret-value" });
    const message = await attempt.catch((error: Error) => error.message);
    expect(message).not.toContain(CODE);
    expect(message).not.toContain(VERIFIER);
    expect(message).not.toContain("super-secret-value");
  });

  it("refuses to send a request with a weak PKCE verifier", async () => {
    const fetch_mock = vi.fn(async () => json_response({}));
    await expect(google_code_exchanger({ fetch: fetch_mock }).exchange({ ...exchange_input(), code_verifier: "short" }))
      .rejects.toMatchObject({ code: "oauth_pkce_invalid" });
    expect(fetch_mock).not.toHaveBeenCalled();
  });

  it("reports a transport failure as an exchange failure", async () => {
    await expect(google_code_exchanger({
      fetch: vi.fn(async () => { throw new Error("network down"); }),
    }).exchange(exchange_input())).rejects.toMatchObject({ code: "oauth_token_exchange_failed" });
  });

  it("bounds an oversized response body", async () => {
    await expect(google_code_exchanger({
      fetch: vi.fn(async () => json_response({ access_token: "a".repeat(100_000), id_token: "id", expires_in: 10 })),
    }).exchange(exchange_input())).rejects.toMatchObject({ code: "oauth_token_exchange_failed" });
  });
});

describe("Supabase authorization-code exchange", () => {
  it("derives the token endpoint from the issuer and authenticates with Basic auth", async () => {
    const fetch_mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://project.supabase.co/auth/v1/oauth/token");
      expect(new URLSearchParams(String(init?.body ?? "")).get("client_secret")).toBeNull();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Basic /);
      return json_response({ access_token: "at", id_token: "it", expires_in: 3600, scope: "openid email" });
    });
    const result = await supabase_code_exchanger("https://project.supabase.co/auth/v1", { fetch: fetch_mock })
      .exchange(exchange_input());
    expect(result.id_token).toBe("it");
    expect(result.granted_scope).toBe("openid email");
  });

  it("supports client_secret_post for a project registered that way", async () => {
    const fetch_mock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      expect(body.get("client_id")).toBe("client-id.apps.googleusercontent.com");
      expect(body.get("client_secret")).toBe("client-secret");
      return json_response({ access_token: "at", id_token: "it", expires_in: 3600 });
    });
    await expect(supabase_code_exchanger("https://project.supabase.co/auth/v1", {
      auth_method: "client_secret_post",
      fetch: fetch_mock,
    }).exchange(exchange_input())).resolves.toMatchObject({ id_token: "it" });
  });

  it("refuses a non-https issuer", () => {
    expect(() => supabase_code_exchanger("http://project.supabase.co/auth/v1")).toThrow(OAuthFlowError);
    expect(() => supabase_code_exchanger("not-a-url")).toThrow(OAuthFlowError);
  });
});