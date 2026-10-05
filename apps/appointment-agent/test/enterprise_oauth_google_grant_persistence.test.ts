/**
 * Contract tests for the durable Google Calendar grant repository.
 *
 * The property under test is that moving grants out of process memory did not
 * weaken them. The repository is the only component that touches a stored grant
 * row, and no method on it accepts a plaintext refresh token, so the question is
 * whether a durable adapter can be talked into persisting one — and whether the
 * two-sided revocation, re-consent, and tenant-binding semantics still hold when
 * the row lives in a database rather than a Map.
 *
 * WHAT THESE TESTS DO NOT PROVE: anything about PostgreSQL. The pooler answers
 * `tenant/user not found` from this environment, so no statement here has ever
 * executed on a real server, and the double interprets statements by table name.
 * In particular the `ON CONFLICT ... WHERE revoked_at IS NULL` upsert and the
 * partial unique index behind it are asserted by shape only. Treat the Postgres
 * path as requiring a rollout-time verification against a real database.
 */

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { PostgresGoogleTokenGrantRepository } from "../src/enterprise/postgres_google_token_grant_repository.js";
import { GoogleTokenGrantStore, GOOGLE_TOKEN_PURPOSE } from "../src/enterprise/google_token_grants.js";
import { InMemoryGoogleTokenGrantRepository } from "../src/enterprise/oauth/google_grant_repository.js";
import { InMemoryOAuthAuditSink } from "../src/enterprise/oauth/oauth_audit.js";
import { create_tenant_secret_cipher } from "../src/security/tenant_secret_cipher.js";
import { parse_recipient_key_ring } from "../src/security/recipient_key_ring.js";
import { FakeAuthTables } from "./support/fake_auth_tables.js";

const START_ISO = "2026-09-25T00:00:00.000Z";
const REFRESH_TOKEN = "1//0eXa-test-refresh-token-value";

/**
 * One throwaway key ring per run, generated at module load.
 *
 * It has to be the same key across "restarts" inside a test: a re-created store
 * that could not decrypt what the previous process wrote would look like a
 * persistence bug when it is really a lost key.
 */
const KEY_RING_ENV: Record<string, string | undefined> = {
  WHATSAPP_RECIPIENT_ENCRYPTION_KEYS_JSON: JSON.stringify({
    active_key_id: "k1",
    keys: { k1: randomBytes(32).toString("base64") },
  }),
};

/** A grant store over the Postgres repository, with a stubbed provider revoke. */
function grant_store(tables: FakeAuthTables): { store: GoogleTokenGrantStore; revoked: string[] } {
  const revoked: string[] = [];
  return {
    store: new GoogleTokenGrantStore(create_tenant_secret_cipher(parse_recipient_key_ring(KEY_RING_ENV)), {
      sink: new InMemoryOAuthAuditSink(),
      revoke_upstream: async (token) => { revoked.push(token); },
      repository: new PostgresGoogleTokenGrantRepository(tables.client(), { clock: () => new Date(START_ISO) }),
    }),
    revoked,
  };
}

/** A grant store with a provider revoker the caller controls. */
function grant_store_with_revoker(
  tables: FakeAuthTables,
  revoke_upstream: (token: string) => Promise<void>,
): GoogleTokenGrantStore {
  return new GoogleTokenGrantStore(create_tenant_secret_cipher(parse_recipient_key_ring(KEY_RING_ENV)), {
    sink: new InMemoryOAuthAuditSink(),
    revoke_upstream,
    repository: new PostgresGoogleTokenGrantRepository(tables.client(), { clock: () => new Date(START_ISO) }),
  });
}

/** Consent input for one tenant, as a callback route supplies it. */
function consent_input(refresh_token: string, tenant_id = "1001") {
  return {
    tenant_id,
    google_subject_id: "google-subject",
    authorized_by_subject_id: "staff-subject-1",
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    refresh_token,
  };
}

describe("the durable grant repository keeps the refresh token encrypted", () => {
  it("persists only ciphertext and reads it back on another instance", async () => {
    const tables = new FakeAuthTables();
    const { store } = grant_store(tables);
    await store.store(consent_input(REFRESH_TOKEN));
    // Nothing bound to the adapter may ever carry the plaintext token.
    expect(JSON.stringify(tables.calls)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify([...tables.grants.values()])).not.toContain(REFRESH_TOKEN);
    const stored = tables.grants.get("1001") as Record<string, unknown>;
    expect(String(stored.encrypted_refresh_token).startsWith("s1.k1.")).toBe(true);
    // A second instance over the same tables still resolves the grant, which is
    // what a redeploy used to destroy.
    const { store: restarted } = grant_store(tables);
    await expect(restarted.resolve_refresh_token("1001")).resolves.toBe(REFRESH_TOKEN);
  });

  it("cannot decrypt a tenant's ciphertext under another tenant", async () => {
    const tables = new FakeAuthTables();
    const { store } = grant_store(tables);
    await store.store(consent_input(REFRESH_TOKEN));
    const row = tables.grants.get("1001") as Record<string, unknown>;
    const cipher = create_tenant_secret_cipher(parse_recipient_key_ring(KEY_RING_ENV));
    // Moving the row to another tenant must fail closed, not silently work.
    expect(() => cipher.decrypt(String(row.encrypted_refresh_token), {
      tenant_id: "2002",
      purpose: GOOGLE_TOKEN_PURPOSE,
    })).toThrow();
    tables.grants.delete("1001");
    tables.grants.set("2002", { ...row, tenant_id: "2002" });
    const { store: moved } = grant_store(tables);
    await expect(moved.resolve_refresh_token("2002")).rejects.toMatchObject({ code: "oauth_token_exchange_failed" });
  });

  it("hides one tenant's grant from another tenant entirely", async () => {
    const tables = new FakeAuthTables();
    const { store } = grant_store(tables);
    await store.store(consent_input(REFRESH_TOKEN));
    const { store: restarted } = grant_store(tables);
    await expect(restarted.resolve_refresh_token("2002")).rejects.toMatchObject({
      code: "oauth_membership_unresolved",
    });
    await expect(restarted.list("2002")).resolves.toEqual([]);
  });

  it("keeps a re-consented grant when an in-flight revoke finishes", async () => {
    const tables = new FakeAuthTables();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = grant_store_with_revoker(tables, async () => { await gate; });
    await store.store(consent_input("1//0eXa-first-token"));
    const revoking = store.revoke_google_grant("1001");
    await Promise.resolve();
    await store.store(consent_input("1//0eXa-second-token"));
    release();
    // Deleting by tenant would destroy a credential Google never revoked, leaving
    // the tenant holding an un-revocable secret.
    await expect(revoking).resolves.toBe(false);
    const { store: restarted } = grant_store(tables);
    await expect(restarted.resolve_refresh_token("1001")).resolves.toBe("1//0eXa-second-token");
  });

  it("leaves the grant resolvable when the provider revoke fails", async () => {
    const tables = new FakeAuthTables();
    const store = grant_store_with_revoker(tables, async () => { throw new Error("google unavailable"); });
    await store.store(consent_input(REFRESH_TOKEN));
    await expect(store.revoke_google_grant("1001")).rejects.toMatchObject({ code: "oauth_token_exchange_failed" });
    const { store: restarted } = grant_store(tables);
    await expect(restarted.resolve_refresh_token("1001")).resolves.toBe(REFRESH_TOKEN);
  });

  it("refuses to persist anything that is not a tenant-secret envelope", async () => {
    const tables = new FakeAuthTables();
    const repository = new PostgresGoogleTokenGrantRepository(tables.client(), { clock: () => new Date(START_ISO) });
    // The port is ciphertext-only by construction; this is the check that stops a
    // caller bug from writing a live credential into the table.
    await expect(repository.replace({
      grant_id: "grant-1",
      tenant_id: "1001",
      google_subject_id: "google-subject",
      authorized_by_subject_id: "staff-subject-1",
      scopes: ["scope"],
      encrypted_refresh_token: REFRESH_TOKEN,
      created_at_iso: START_ISO,
      last_used_at_iso: null,
      revoked_at_iso: null,
    })).rejects.toMatchObject({ code: "oauth_configuration_invalid" });
    expect(tables.grants.size).toBe(0);
  });

  it("redacts the ciphertext in the listing projection", async () => {
    const tables = new FakeAuthTables();
    const { store } = grant_store(tables);
    await store.store(consent_input(REFRESH_TOKEN));
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ tenant_id: "1001", encrypted_refresh_token: "[redacted]" }),
    ]);
  });

  it("exchanges one in-memory grant for one durable grant without changing behaviour", async () => {
    // Same contract, two repositories: the store is not the thing that changed.
    const tables = new FakeAuthTables();
    const cipher = create_tenant_secret_cipher(parse_recipient_key_ring(KEY_RING_ENV));
    const memory = new GoogleTokenGrantStore(cipher, {
      repository: new InMemoryGoogleTokenGrantRepository(),
      revoke_upstream: async () => undefined,
    });
    for (const target of [memory, grant_store(tables).store]) {
      await target.store(consent_input(REFRESH_TOKEN));
      await expect(target.resolve_refresh_token("1001")).resolves.toBe(REFRESH_TOKEN);
      await expect(target.list()).resolves.toEqual([
        expect.objectContaining({ tenant_id: "1001", encrypted_refresh_token: "[redacted]" }),
      ]);
    }
  });
});
