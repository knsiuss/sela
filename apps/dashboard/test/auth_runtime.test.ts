/**
 * Composition-root coverage for staff authentication.
 *
 * `runtime()` is the only place the dashboard decides which stores, key caches,
 * and redirect origin it will serve with, so its refusals and its wiring are the
 * evidence that the composed object is the safe one. Nothing here reaches the
 * network: the Google revocation transport and the recipient key ring are both
 * supplied through the environment the runtime is handed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { reset_runtime, revoke_google_grant, runtime } from "../src/app/auth/runtime";
import { read_session_cookie, safe_message, status_for, workspace_redirect } from "../src/app/auth/route_helpers";
import { OAuthFlowError } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import type { StaffAuthRuntime } from "../src/app/auth/runtime";

const KEY_BASE64 = randomBytes(32).toString("base64");

/** A fully configured loopback environment: the only shape `runtime` accepts. */
const LOOPBACK_ENV: Record<string, string> = {
  STAFF_AUTH_REDIRECT_ALLOW_LIST: "http://127.0.0.1:3000/auth/callback",
  STAFF_AUTH_LOGIN_REDIRECT_URI: "http://127.0.0.1:3000/auth/callback",
  STAFF_AUTH_CALENDAR_REDIRECT_URI: "http://127.0.0.1:3000/auth/callback",
  STAFF_AUTH_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
  STAFF_AUTH_ALLOW_INSECURE_LOOPBACK: "true",
  STAFF_DIRECTORY_JSON: JSON.stringify({
    entries: [{
      issuer: "https://idp.test.invalid",
      subject_id: "staff-subject-1",
      org_id: "acme",
      tenant_id: "1001",
      roles: ["owner"],
      status: "active",
      invited_at_iso: "2026-01-01T00:00:00.000Z",
      updated_at_iso: "2026-01-02T00:00:00.000Z",
    }],
  }),
  WHATSAPP_RECIPIENT_ENCRYPTION_KEYS_JSON: JSON.stringify({ active_key_id: "k1", keys: { k1: KEY_BASE64 } }),
  SUPABASE_AUTH_ISSUER_URL: "https://idp.test.invalid/auth/v1",
  SUPABASE_AUTH_JWKS_URL: "https://idp.test.invalid/auth/v1/jwks",
  SUPABASE_AUTH_STAFF_AUDIENCE: "supabase-client-id",
  SUPABASE_AUTH_OAUTH_CLIENT_ID: "supabase-client-id",
  SUPABASE_AUTH_OAUTH_CLIENT_SECRET: "supabase-client-secret",
};

afterEach(() => {
  reset_runtime();
  vi.restoreAllMocks();
});

/** Build a runtime from the loopback environment without touching process.env. */
function loopback_runtime(): StaffAuthRuntime {
  return runtime(LOOPBACK_ENV);
}

describe("staff auth composition root", () => {
  it("refuses to start when in-memory stores would serve a non-loopback origin", () => {
    // The state, session, and grant stores are single-process, so a second
    // instance would not see a login state or a revocation issued by the first.
    expect(() => runtime({
      ...LOOPBACK_ENV,
      STAFF_AUTH_PUBLIC_BASE_URL: "https://staff.example.com",
      STAFF_AUTH_ALLOW_INSECURE_LOOPBACK: "false",
      STAFF_AUTH_REDIRECT_ALLOW_LIST: "https://staff.example.com/auth/callback",
      STAFF_AUTH_LOGIN_REDIRECT_URI: "https://staff.example.com/auth/callback",
      STAFF_AUTH_CALENDAR_REDIRECT_URI: "https://staff.example.com/auth/callback",
    })).toThrow(OAuthFlowError);
    expect(() => loopback_runtime()).not.toThrow();
  });

  it("performs an upstream Google revoke through the composed grant store", async () => {
    const parts = loopback_runtime();
    const revoked: string[] = [];
    const fetch_spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      revoked.push(new URLSearchParams(String(init?.body ?? "")).get("token") ?? "");
      return new Response("", { status: 200 });
    });
    await parts.grants.store({
      tenant_id: "1001",
      google_subject_id: "google-subject",
      authorized_by_subject_id: "staff-subject-1",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      refresh_token: "1//0eXa-refresh-token-value",
    });
    await expect(revoke_google_grant(parts, "1001")).resolves.toBe(true);
    expect(revoked).toEqual(["1//0eXa-refresh-token-value"]);
    expect(String(fetch_spy.mock.calls[0]?.[0])).toBe("https://oauth2.googleapis.com/revoke");
    expect(parts.grants.list()).toEqual([]);
  });

  it("leaves the grant stored when the composed upstream revoke fails", async () => {
    const parts = loopback_runtime();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 500 }));
    await parts.grants.store({
      tenant_id: "1001",
      google_subject_id: "google-subject",
      authorized_by_subject_id: "staff-subject-1",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      refresh_token: "1//0eXa-refresh-token-value",
    });
    await expect(revoke_google_grant(parts, "1001")).rejects.toMatchObject({ code: "oauth_token_exchange_failed" });
    await expect(parts.grants.resolve_refresh_token("1001")).resolves.toBe("1//0eXa-refresh-token-value");
  });

  it("holds one signing-key cache per configured provider", () => {
    const parts = loopback_runtime();
    expect([...parts.key_sets.keys()]).toEqual(["supabase"]);
    expect(parts.key_sets.get("supabase")).toBe(parts.key_sets.get("supabase"));
  });
});

describe("route helpers", () => {
  it("builds a post-credential redirect on the configured origin, not the request host", () => {
    const parts = loopback_runtime();
    expect(workspace_redirect(parts, "/actions")).toBe("http://127.0.0.1:3000/actions");
    expect(workspace_redirect(parts, "/actions?calendar=1001")).toBe("http://127.0.0.1:3000/actions?calendar=1001");
    for (const path of ["https://evil.example/x", "//evil.example/x", "/actions/../admin"]) {
      expect(() => workspace_redirect(parts, path)).toThrow(OAuthFlowError);
    }
  });

  it("redirects a logout to the configured base URL when the request Host differs", async () => {
    const { POST } = await import("../src/app/auth/logout/route");
    process.env = { ...process.env, ...LOOPBACK_ENV };
    reset_runtime();
    try {
      const response = await POST(new Request("http://attacker.example/auth/logout", {
        method: "POST",
        headers: { host: "attacker.example" },
      }));
      const location = new URL(response.headers.get("Location") ?? "");
      // The freshly cleared cookie rides along on this redirect, so the origin it
      // points at must be configuration rather than the request's Host header.
      expect(location.origin).toBe("http://127.0.0.1:3000");
      expect(location.host).not.toBe("attacker.example");
      expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    } finally {
      delete process.env.STAFF_AUTH_PUBLIC_BASE_URL;
      reset_runtime();
    }
  });

  it("refuses a cross-origin logout before doing anything", async () => {
    const { POST } = await import("../src/app/auth/logout/route");
    process.env = { ...process.env, ...LOOPBACK_ENV };
    reset_runtime();
    try {
      const response = await POST(new Request("http://127.0.0.1:3000/auth/logout", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      }));
      expect(response.status).toBe(403);
    } finally {
      delete process.env.STAFF_AUTH_PUBLIC_BASE_URL;
      reset_runtime();
    }
  });

  it("reads the session cookie under either policy name", () => {
    expect(read_session_cookie("__Host-sel_session=abc.def")).toBe("abc.def");
    expect(read_session_cookie("sel_session=abc.def")).toBe("abc.def");
    expect(read_session_cookie("other=1; sel_session=abc.def")).toBe("abc.def");
    expect(read_session_cookie(null)).toBeUndefined();
    expect(read_session_cookie("other=1")).toBeUndefined();
  });

  it("maps a flow failure to its sanitized status and message", () => {
    expect(status_for(new OAuthFlowError("oauth_configuration_invalid"))).toBe(503);
    expect(safe_message(new OAuthFlowError("oauth_state_replayed"))).toBe("oauth_state_replayed");
    expect(status_for(new Error("provider said something"))).toBe(503);
    expect(safe_message(new Error("provider said something"))).toBe("staff-auth-unavailable");
  });
});
