/**
 * Encryption-at-rest, tenant isolation, and redaction coverage for stored
 * Google Calendar refresh tokens.
 *
 * The plaintext assertion is the load-bearing one: a test that only checks
 * round-tripping would pass even if the store kept the token in the clear, so
 * the stored rows are serialized and searched for the literal token.
 */

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { GoogleTokenGrantStore } from "../src/enterprise/google_token_grants.js";
import { create_tenant_secret_cipher } from "../src/security/tenant_secret_cipher.js";
import { parse_recipient_key_ring } from "../src/security/recipient_key_ring.js";
import { InMemoryOAuthAuditSink } from "../src/enterprise/oauth/oauth_audit.js";
import { OAuthFlowError } from "../src/enterprise/oauth/oauth_error.js";
import { parse_staff_auth_config } from "../src/enterprise/oauth/staff_auth_config.js";

const KEY_BASE64 = randomBytes(32).toString("base64");
const KEY_RING_JSON = JSON.stringify({ active_key_id: "k1", keys: { k1: KEY_BASE64 } });
const REFRESH_TOKEN = "1//0g-refresh-token-value-that-must-never-be-stored-in-clear";
const GOOGLE_SUBJECT = "google-account-opaque-subject";

function build_store() {
  const ring = parse_recipient_key_ring({ WHATSAPP_RECIPIENT_ENCRYPTION_KEYS_JSON: KEY_RING_JSON });
  const cipher = create_tenant_secret_cipher(ring);
  const sink = new InMemoryOAuthAuditSink();
  const store = new GoogleTokenGrantStore(cipher, { sink, clock: () => new Date("2026-09-25T00:00:00.000Z") });
  return { store, sink };
}

async function store_grant(tenant_id: string) {
  const parts = build_store();
  await parts.store.store({
    tenant_id,
    google_subject_id: GOOGLE_SUBJECT,
    authorized_by_subject_id: "staff-subject-1",
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    refresh_token: REFRESH_TOKEN,
  });
  return parts;
}

describe("Google refresh tokens are encrypted at rest", () => {
  it("never stores the plaintext refresh token in any row", async () => {
    const { store } = await store_grant("1001");
    const serialized = JSON.stringify(store.list("1001"));
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).toContain("[redacted]");
  });

  it("stores ciphertext that carries the key id and version", async () => {
    const { store } = await store_grant("1001");
    const stored = store.list("1001")[0];
    expect(stored?.encrypted_refresh_token).toBe("[redacted]");
    // Reach past the redacted projection to assert the envelope shape itself.
    const raw = await read_raw_ciphertext(store);
    expect(raw.startsWith("s1.k1.")).toBe(true);
    expect(raw).not.toContain(REFRESH_TOKEN);
  });

  it("round-trips the token through the cipher for the owning tenant", async () => {
    const { store } = await store_grant("1001");
    await expect(store.resolve_refresh_token("1001")).resolves.toBe(REFRESH_TOKEN);
  });

  it("produces different ciphertext for the same token in different tenants", async () => {
    const first = await store_grant("1001");
    const second = await store_grant("2002");
    const left = await read_raw_ciphertext(first.store, "1001");
    const right = await read_raw_ciphertext(second.store, "2002");
    expect(left).not.toBe(right);
  });
});

describe("cross-tenant refresh-token isolation", () => {
  it("cannot read another tenant's grant", async () => {
    const { store } = await store_grant("1001");
    await expect(store.resolve_refresh_token("2002")).rejects.toMatchObject({ code: "oauth_membership_unresolved" });
  });

  it("fails closed when a ciphertext is moved into another tenant's row", async () => {
    const parts = build_store();
    await parts.store.store({
      tenant_id: "1001",
      google_subject_id: GOOGLE_SUBJECT,
      authorized_by_subject_id: "staff-subject-1",
      scopes: ["scope-a"],
      refresh_token: REFRESH_TOKEN,
    });
    const stolen = await read_raw_ciphertext(parts.store, "1001");
    // Simulate a database row copied under a different tenant by sealing the
    // stolen ciphertext into a second store and reading it with the wrong
    // tenant context through the cipher directly.
    const ring = parse_recipient_key_ring({ WHATSAPP_RECIPIENT_ENCRYPTION_KEYS_JSON: KEY_RING_JSON });
    const cipher = create_tenant_secret_cipher(ring);
    expect(() => cipher.decrypt(stolen, { tenant_id: "2002", purpose: "google_refresh_token" })).toThrow();
    expect(() => cipher.decrypt(stolen, { tenant_id: "1001", purpose: "some_other_purpose" })).toThrow();
  });

  it("keeps the tenant-to-account mapping explicit and auditable", async () => {
    const { store } = await store_grant("1001");
    expect(store.list()).toEqual([
      expect.objectContaining({
        tenant_id: "1001",
        google_subject_id: GOOGLE_SUBJECT,
        authorized_by_subject_id: "staff-subject-1",
        scopes: ["https://www.googleapis.com/auth/calendar.events"],
        revoked_at_iso: null,
      }),
    ]);
  });
});

describe("grant revocation is two-sided", () => {
  it("deletes the local row and asks the provider to invalidate", async () => {
    const revoked: string[] = [];
    const ring = parse_recipient_key_ring({ WHATSAPP_RECIPIENT_ENCRYPTION_KEYS_JSON: KEY_RING_JSON });
    const store = new GoogleTokenGrantStore(create_tenant_secret_cipher(ring), {
      revoke_upstream: async (token) => { revoked.push(token); },
    });
    await store.store({
      tenant_id: "1001",
      google_subject_id: GOOGLE_SUBJECT,
      authorized_by_subject_id: "staff-subject-1",
      scopes: ["scope-a"],
      refresh_token: REFRESH_TOKEN,
    });
    await expect(store.revoke_google_grant("1001")).resolves.toBe(true);
    expect(revoked).toEqual([REFRESH_TOKEN]);
    expect(store.list()).toEqual([]);
    await expect(store.resolve_refresh_token("1001")).rejects.toBeInstanceOf(OAuthFlowError);
  });

  it("reports that upstream revocation is impossible without a revoker", async () => {
    const { store } = await store_grant("1001");
    // The store deliberately holds no Google client secret, so it must not
    // pretend a provider-side revoke happened.
    await expect(store.revoke_google_grant("1001")).rejects.toMatchObject({ code: "oauth_configuration_invalid" });
    expect(store.list()).toEqual([]);
  });

  it("marks a grant unusable after an upstream revocation", async () => {
    const { store } = await store_grant("1001");
    await store.mark_unusable("1001");
    await expect(store.resolve_refresh_token("1001")).rejects.toMatchObject({ code: "oauth_membership_unresolved" });
  });
});

describe("audit records never carry credential material", () => {
  it("emits only vocabulary, tenant, provider, and timestamp", async () => {
    const { store, sink } = await store_grant("1001");
    await store.resolve_refresh_token("1001");
    await store.revoke_google_grant("1001").catch(() => undefined);
    expect(sink.records.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(sink.records);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain(GOOGLE_SUBJECT);
    expect(serialized).not.toContain("@");
    for (const record of sink.records) {
      expect(record.tenant_id).toBe("1001");
      expect(record.idp).toBe("google");
    }
  });
});

describe("staff auth configuration fails closed", () => {
  const base_env = {
    STAFF_AUTH_REDIRECT_ALLOW_LIST: "https://staff.example.com/auth/callback",
    STAFF_AUTH_LOGIN_REDIRECT_URI: "https://staff.example.com/auth/callback",
    STAFF_AUTH_CALENDAR_REDIRECT_URI: "https://staff.example.com/auth/callback",
    STAFF_AUTH_PUBLIC_BASE_URL: "https://staff.example.com",
    SUPABASE_AUTH_ISSUER_URL: "https://project.supabase.co/auth/v1",
    SUPABASE_AUTH_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
    SUPABASE_AUTH_STAFF_AUDIENCE: "supabase-client-id",
    SUPABASE_AUTH_OAUTH_CLIENT_ID: "supabase-client-id",
    SUPABASE_AUTH_OAUTH_CLIENT_SECRET: "supabase-client-secret",
  };

  it("parses a complete Supabase configuration", () => {
    const config = parse_staff_auth_config(base_env);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.idp).toBe("supabase");
    expect(config.cookie.secure).toBe(true);
  });

  it("parses both providers together", () => {
    const config = parse_staff_auth_config({
      ...base_env,
      GOOGLE_OAUTH_ISSUER_URL: "https://accounts.google.com",
      GOOGLE_OAUTH_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
      GOOGLE_OAUTH_STAFF_AUDIENCE: "google-client-id",
      GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      GOOGLE_WORKSPACE_HOSTED_DOMAIN: "Example.COM",
    });
    expect(config.providers.map((provider) => provider.idp)).toEqual(["supabase", "google"]);
    expect(config.providers[1]?.hosted_domain).toBe("example.com");
  });

  it("refuses an environment with no provider at all", () => {
    expect(() => parse_staff_auth_config({
      STAFF_AUTH_REDIRECT_ALLOW_LIST: "https://staff.example.com/auth/callback",
      STAFF_AUTH_LOGIN_REDIRECT_URI: "https://staff.example.com/auth/callback",
      STAFF_AUTH_CALENDAR_REDIRECT_URI: "https://staff.example.com/auth/callback",
      STAFF_AUTH_PUBLIC_BASE_URL: "https://staff.example.com",
    })).toThrow(OAuthFlowError);
  });

  it("refuses a partially configured provider instead of ignoring the half", () => {
    expect(() => parse_staff_auth_config({
      ...base_env,
      SUPABASE_AUTH_OAUTH_CLIENT_SECRET: "",
    })).toThrow(OAuthFlowError);
  });

  it("refuses a callback URI that is not on the allow-list", () => {
    expect(() => parse_staff_auth_config({
      ...base_env,
      STAFF_AUTH_LOGIN_REDIRECT_URI: "https://attacker.example.com/auth/callback",
    })).toThrow(OAuthFlowError);
  });

  it("refuses an absent allow-list rather than trusting the callback value", () => {
    const { STAFF_AUTH_REDIRECT_ALLOW_LIST: _omitted, ...without_list } = base_env;
    expect(() => parse_staff_auth_config(without_list)).toThrow(OAuthFlowError);
  });

  it("refuses a non-https issuer or JWKS URL", () => {
    expect(() => parse_staff_auth_config({ ...base_env, SUPABASE_AUTH_JWKS_URL: "http://project.supabase.co/jwks" }))
      .toThrow(OAuthFlowError);
  });

  it("accepts an http loopback origin only with the explicit opt-in", () => {
    const loopback = {
      ...base_env,
      STAFF_AUTH_REDIRECT_ALLOW_LIST: "http://127.0.0.1:3000/auth/callback",
      STAFF_AUTH_LOGIN_REDIRECT_URI: "http://127.0.0.1:3000/auth/callback",
      STAFF_AUTH_CALENDAR_REDIRECT_URI: "http://127.0.0.1:3000/auth/callback",
      STAFF_AUTH_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    };
    expect(() => parse_staff_auth_config(loopback)).toThrow(OAuthFlowError);
    const opted_in = parse_staff_auth_config({ ...loopback, STAFF_AUTH_ALLOW_INSECURE_LOOPBACK: "true" });
    expect(opted_in.cookie.secure).toBe(false);
  });

  it("refuses a malformed Workspace hosted domain", () => {
    expect(() => parse_staff_auth_config({
      ...base_env,
      GOOGLE_OAUTH_ISSUER_URL: "https://accounts.google.com",
      GOOGLE_OAUTH_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
      GOOGLE_OAUTH_STAFF_AUDIENCE: "google-client-id",
      GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      GOOGLE_WORKSPACE_HOSTED_DOMAIN: "not a domain",
    })).toThrow(OAuthFlowError);
  });
});

/**
 * Read a grant's ciphertext past the redacted audit projection.
 *
 * The public `list()` deliberately redacts, so the assertion about what is
 * actually persisted has to go through the store's own closure state. Reading it
 * the same way an operator would, by inspecting memory, keeps the test honest
 * about which field it is checking.
 */
async function read_raw_ciphertext(store: GoogleTokenGrantStore, tenant_id = "1001"): Promise<string> {
  const rows = (store as unknown as { grants: Map<string, { encrypted_refresh_token: string }> }).grants;
  const row = rows.get(tenant_id);
  if (row === undefined) throw new Error("grant-row-missing");
  return row.encrypted_refresh_token;
}