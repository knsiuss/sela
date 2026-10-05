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

/** Loopback origin served over https, so the policy issues the `__Host-` cookie. */
const SECURE_LOOPBACK_ENV: Record<string, string> = {
  ...LOOPBACK_ENV,
  STAFF_AUTH_REDIRECT_ALLOW_LIST: "https://127.0.0.1:3000/auth/callback",
  STAFF_AUTH_LOGIN_REDIRECT_URI: "https://127.0.0.1:3000/auth/callback",
  STAFF_AUTH_CALENDAR_REDIRECT_URI: "https://127.0.0.1:3000/auth/callback",
  STAFF_AUTH_PUBLIC_BASE_URL: "https://127.0.0.1:3000",
  STAFF_AUTH_ALLOW_INSECURE_LOOPBACK: "false",
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
    await parts.stores.grants.store({
      tenant_id: "1001",
      google_subject_id: "google-subject",
      authorized_by_subject_id: "staff-subject-1",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      refresh_token: "1//0eXa-refresh-token-value",
    });
    await expect(revoke_google_grant(parts, "1001")).resolves.toBe(true);
    expect(revoked).toEqual(["1//0eXa-refresh-token-value"]);
    expect(String(fetch_spy.mock.calls[0]?.[0])).toBe("https://oauth2.googleapis.com/revoke");
    expect(await parts.stores.grants.list()).toEqual([]);
    // RB-15 is answered from this trail, so the grant half has to be in it and
    // not in a second sink the responder never reads.
    expect(parts.audit.records).toContainEqual(expect.objectContaining({
      event: "calendar_grant_revoked",
      outcome: "revoked",
      tenant_id: "1001",
    }));
    expect(parts.metrics.counter_value("oauth_flow_total", { event: "calendar_grant_revoked", outcome: "revoked" }))
      .toBeGreaterThan(0);
  });

  it("leaves the grant stored and audited when the composed upstream revoke fails", async () => {
    const parts = loopback_runtime();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 500 }));
    await parts.stores.grants.store({
      tenant_id: "1001",
      google_subject_id: "google-subject",
      authorized_by_subject_id: "staff-subject-1",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      refresh_token: "1//0eXa-refresh-token-value",
    });
    await expect(revoke_google_grant(parts, "1001")).rejects.toMatchObject({ code: "oauth_token_exchange_failed" });
    await expect(parts.stores.grants.resolve_refresh_token("1001")).resolves.toBe("1//0eXa-refresh-token-value");
    expect(parts.audit.records).toContainEqual(expect.objectContaining({
      event: "calendar_grant_revoked",
      outcome: "failed",
    }));
  });

  it("keeps a re-consent that lands during an in-flight revoke", async () => {
    const parts = loopback_runtime();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await gate;
      return new Response("", { status: 200 });
    });
    await parts.stores.grants.store({
      tenant_id: "1001",
      google_subject_id: "google-subject",
      authorized_by_subject_id: "staff-subject-1",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      refresh_token: "1//0eXa-first-refresh-token",
    });
    const revoking = revoke_google_grant(parts, "1001");
    await Promise.resolve();
    await parts.stores.grants.store({
      tenant_id: "1001",
      google_subject_id: "google-subject",
      authorized_by_subject_id: "staff-subject-1",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      refresh_token: "1//0eXa-second-refresh-token",
    });
    release();
    // The revoke retires only the credential Google invalidated, so the newer
    // grant stays resolvable and the audit does not claim it was revoked.
    await expect(revoking).resolves.toBe(false);
    await expect(parts.stores.grants.resolve_refresh_token("1001")).resolves.toBe("1//0eXa-second-refresh-token");
    const revoke_records = parts.audit.records.filter((record) => record.event === "calendar_grant_revoked");
    expect(revoke_records.map((record) => record.outcome)).toEqual(["ok"]);
  });

  it("holds one signing-key cache per configured provider", () => {
    const parts = loopback_runtime();
    expect([...parts.key_sets.keys()]).toEqual(["supabase"]);
    expect(parts.key_sets.get("supabase")).toBe(parts.key_sets.get("supabase"));
  });
});

describe("signing-key cache lifetime", () => {
  it("defaults to the previous five-minute window when unset", () => {
    expect(loopback_runtime().key_sets.get("supabase")?.jwks_cache_ms).toBe(300_000);
  });

  it("takes the configured window from STAFF_AUTH_JWKS_CACHE_MS", () => {
    const parts = runtime({ ...LOOPBACK_ENV, STAFF_AUTH_JWKS_CACHE_MS: "30" });
    expect(parts.key_sets.get("supabase")?.jwks_cache_ms).toBe(30_000);
  });

  it("refuses an out-of-range window at startup instead of defaulting", () => {
    for (const value of ["29", "3601", "0", "-60", "30.5", "not-a-number"]) {
      expect(() => runtime({ ...LOOPBACK_ENV, STAFF_AUTH_JWKS_CACHE_MS: value }), value).toThrow(OAuthFlowError);
    }
  });
});

describe("route helpers", () => {
  it("builds a post-credential redirect on the configured origin, not the request host", () => {
    const parts = loopback_runtime();
    expect(workspace_redirect(parts, "/actions")).toBe("http://127.0.0.1:3000/actions");
    expect(workspace_redirect(parts, "/actions?calendar=1001")).toBe("http://127.0.0.1:3000/actions?calendar=1001");
    // The backslash forms satisfy a "starts with `/`" shape check and still parse
    // to a foreign authority, so the resolved origin is what gets compared.
    for (const path of [
      "https://evil.example/x",
      "//evil.example/x",
      "/actions/../admin",
      "/\\evil.example",
      "/\\/evil.example",
    ]) {
      expect(() => workspace_redirect(parts, path), path).toThrow(OAuthFlowError);
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

  it("reads the session cookie under the policy's name, not the header's order", () => {
    const parts = loopback_runtime();
    expect(parts.config.cookie.name).toBe("sel_session");
    expect(read_session_cookie(parts, "__Host-sel_session=abc.def")).toBe("abc.def");
    expect(read_session_cookie(parts, "sel_session=abc.def")).toBe("abc.def");
    expect(read_session_cookie(parts, "other=1; sel_session=abc.def")).toBe("abc.def");
    expect(read_session_cookie(parts, null)).toBeUndefined();
    expect(read_session_cookie(parts, "other=1")).toBeUndefined();
    // Both names present: the policy decides, so this surface and the Server
    // Component reader resolve the same session instead of different tenants.
    expect(read_session_cookie(parts, "sel_session=plain; __Host-sel_session=hosted")).toBe("plain");
  });

  it("resolves the same session on both readers when a browser sends both names", async () => {
    const { select_session_cookie } = await import("appointment-agent/dist/src/enterprise/oauth/index.js");
    const insecure = loopback_runtime();
    reset_runtime();
    const secure = runtime(SECURE_LOOPBACK_ENV);
    expect(secure.config.cookie.name).toBe("__Host-sel_session");
    // Header order used to decide here, so a page could render as one tenant
    // while a route handler action executed as another.
    const header = "sel_session=plain; __Host-sel_session=hosted";
    const jar_lookup = (name: string) => new Map([
      ["sel_session", "plain"],
      ["__Host-sel_session", "hosted"],
    ]).get(name);
    for (const [parts, expected] of [[insecure, "plain"], [secure, "hosted"]] as const) {
      expect(read_session_cookie(parts, header)).toBe(expected);
      expect(select_session_cookie(parts.config.cookie, jar_lookup)).toBe(expected);
    }
  });

  it("maps a flow failure to its sanitized status and message", () => {
    expect(status_for(new OAuthFlowError("oauth_configuration_invalid"))).toBe(503);
    expect(safe_message(new OAuthFlowError("oauth_state_replayed"))).toBe("oauth_state_replayed");
    expect(status_for(new Error("provider said something"))).toBe(503);
    expect(safe_message(new Error("provider said something"))).toBe("staff-auth-unavailable");
  });
});
