/**
 * Contract tests for the durable staff-auth stores.
 *
 * WHAT THESE TESTS PROVE, precisely: that each Postgres adapter's row mapping,
 * input validation, parameter binding, and statement shape are correct, and that
 * the single-use and revocation semantics hold across two independent adapter
 * instances sharing one backing store.
 *
 * WHAT THEY DO NOT PROVE: anything about PostgreSQL. The pooler answers
 * `tenant/user not found` from this environment, so no statement here has ever
 * executed on a real server. The double below interprets the statements by table
 * name, which means a SQL *error* — a wrong column list, a syntax problem, a
 * constraint the migration forbids — would not be caught here. The atomic-claim
 * argument in particular rests on the statement being
 * `UPDATE ... WHERE consumed_at IS NULL RETURNING`; the assertions below check that
 * the adapter sends such a statement, not that the database enforces it. Treat the
 * Postgres path as requiring a rollout-time verification against a real database.
 */

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { PostgresOAuthStateStore } from "../src/enterprise/oauth/postgres_oauth_state_store.js";
import { PostgresStaffSessionStore } from "../src/enterprise/oauth/postgres_staff_session_store.js";
import type { SqlClient } from "../src/persistence/sql_client.js";
import type { AuthenticatedPrincipal } from "../src/enterprise/authorization.js";
import type { IssueOAuthStateInput } from "../src/enterprise/oauth/oauth_state.js";
import { FakeAuthTables } from "./support/fake_auth_tables.js";

/** Fixed clock for every deterministic expiry assertion in this file. */
const START_ISO = "2026-09-25T00:00:00.000Z";
const START_MS = Date.parse(START_ISO);

/** Build a principal the directory would have returned for a staff member. */
function principal_for(tenant_id: string): AuthenticatedPrincipal {
  return {
    subject_id: "staff-subject-1",
    issuer: "https://idp.test.invalid",
    has_mfa: true,
    tenant_roles: { [tenant_id]: ["owner"] },
    session_id: "unused",
    issued_at_iso: START_ISO,
  } as unknown as AuthenticatedPrincipal;
}

/** Issuance input the routes supply for a staff login. */
function issue_input(overrides: Partial<IssueOAuthStateInput> = {}): IssueOAuthStateInput {
  return {
    purpose: "staff_login",
    idp: "supabase",
    tenant_id: null,
    return_path: "/actions",
    code_verifier: "a".repeat(43),
    nonce: "n".repeat(32),
    ...overrides,
  };
}

/** Two adapter instances over one backing store: a restart and a second replica. */
function two_instances(): { tables: FakeAuthTables; first: SqlClient; second: SqlClient } {
  const tables = new FakeAuthTables();
  return { tables, first: tables.client(), second: tables.client() };
}

describe("the durable state store is single-use across instances", () => {
  it("lets a second instance claim a state the first one issued", async () => {
    const { first, second } = two_instances();
    const issued = await new PostgresOAuthStateStore(first, { clock: () => new Date(START_MS) }).issue(issue_input());
    // The failure this replaces: a callback on another instance answered
    // `oauth_state_unknown` and the login silently never completed.
    const claimed = await new PostgresOAuthStateStore(second, { clock: () => new Date(START_MS) })
      .consume(issued.state);
    expect(claimed.purpose).toBe("staff_login");
    expect(claimed.return_path).toBe("/actions");
  });

  it("reports a second claim as a replay rather than letting both succeed", async () => {
    const { tables, first, second } = two_instances();
    const store_a = new PostgresOAuthStateStore(first, { clock: () => new Date(START_MS) });
    const store_b = new PostgresOAuthStateStore(second, { clock: () => new Date(START_MS) });
    const issued = await store_a.issue(issue_input());
    await store_a.consume(issued.state);
    await expect(store_b.consume(issued.state)).rejects.toMatchObject({ code: "oauth_state_replayed" });
    // The claim must be one conditional statement, not a read followed by a write:
    // that pairing is exactly the window in which two instances both win.
    const claim = tables.calls.find((call) => call.sql.includes("SET consumed_at"));
    expect(claim?.sql).toContain("consumed_at IS NULL");
    expect(claim?.sql).toContain("RETURNING");
    expect(tables.calls.filter((call) => call.sql.includes("SET consumed_at"))).toHaveLength(2);
  });

  it("preserves the missing, malformed, and unknown classifications", async () => {
    const { first } = two_instances();
    const store = new PostgresOAuthStateStore(first, { clock: () => new Date(START_MS) });
    await expect(store.consume(undefined)).rejects.toMatchObject({ code: "oauth_state_missing" });
    await expect(store.consume("short")).rejects.toMatchObject({ code: "oauth_state_malformed" });
    await expect(store.consume(Buffer.alloc(32, 7).toString("base64url"))).rejects.toMatchObject({
      code: "oauth_state_unknown",
    });
  });

  it("keeps a tenant-bound state from being spent on another tenant's flow", async () => {
    const { first } = two_instances();
    const store = new PostgresOAuthStateStore(first, { clock: () => new Date(START_MS) });
    const issued = await store.issue(issue_input({ purpose: "calendar_consent", tenant_id: "1001" }));
    const claimed = await store.consume(issued.state);
    expect(claimed.tenant_id).toBe("1001");
    expect(claimed.purpose).toBe("calendar_consent");
  });

  it("reclaims rows past their replay grace window", async () => {
    let now_ms = START_MS;
    const { tables, first } = two_instances();
    const store = new PostgresOAuthStateStore(first, { clock: () => new Date(now_ms) });
    await store.issue(issue_input());
    await store.issue(issue_input());
    expect(tables.states.size).toBe(2);
    now_ms += 400_000;
    await expect(store.prune_expired()).resolves.toBe(2);
    expect(tables.states.size).toBe(0);
  });
});

describe("the durable session store survives a restart and stays revocable", () => {
  it("resolves a session created by another instance", async () => {
    const { first, second } = two_instances();
    const clock = () => new Date(START_MS);
    const created = await new PostgresStaffSessionStore(first, { clock }).create({
      subject_id: "staff-subject-1",
      issuer: "https://idp.test.invalid",
      idp: "supabase",
      has_mfa: true,
      principal: principal_for("1001"),
      device_id: "device-opaque-1",
      ttl_seconds: 3_600,
    });
    // Restart-survival: the cookie presented to the new process still resolves.
    const resolved = await new PostgresStaffSessionStore(second, { clock }).resolve(created.cookie_value);
    expect(resolved.subject_id).toBe("staff-subject-1");
    expect(resolved.has_mfa).toBe(true);
    expect(resolved.tenant_roles).toEqual({ "1001": ["owner"] });
  });

  it("refuses a session another instance revoked, and never stores the cookie secret", async () => {
    const { tables, first, second } = two_instances();
    const clock = () => new Date(START_MS);
    const created = await new PostgresStaffSessionStore(first, { clock }).create({
      subject_id: "staff-subject-1",
      issuer: "https://idp.test.invalid",
      idp: "supabase",
      has_mfa: true,
      principal: principal_for("1001"),
      device_id: "device-opaque-1",
      ttl_seconds: 3_600,
    });
    const [session_id, secret] = created.cookie_value.split(".") as [string, string];
    expect(JSON.stringify([...tables.sessions.values()])).not.toContain(secret);

    await new PostgresStaffSessionStore(first, { clock }).revoke_by_cookie(created.cookie_value);
    // A logout honoured only by the instance that received it was a per-instance
    // suggestion; the second instance must agree the session is dead.
    await expect(new PostgresStaffSessionStore(second, { clock }).resolve(created.cookie_value))
      .rejects.toMatchObject({ code: "oauth_session_unavailable" });
    await expect(new PostgresStaffSessionStore(second, { clock }).revoke_by_cookie(created.cookie_value))
      .rejects.toMatchObject({ code: "oauth_session_unavailable" });
    expect(session_id.length).toBeGreaterThan(0);
  });

  it("refuses a cookie whose secret does not match the row", async () => {
    const { first } = two_instances();
    const clock = () => new Date(START_MS);
    const created = await new PostgresStaffSessionStore(first, { clock }).create({
      subject_id: "staff-subject-1",
      issuer: "https://idp.test.invalid",
      idp: "supabase",
      has_mfa: true,
      principal: principal_for("1001"),
      device_id: "device-opaque-1",
      ttl_seconds: 3_600,
    });
    const [session_id] = created.cookie_value.split(".") as [string, string];
    const other = new PostgresStaffSessionStore(first, { clock });
    const forged = `${session_id}.${randomBytes(24).toString("base64url")}`;
    // Both cookie halves address the row key, so only the stored hash can refuse.
    await expect(other.resolve(forged)).rejects.toMatchObject({ code: "oauth_session_unavailable" });
  });

  it("refuses an expired session and removes the row", async () => {
    let now_ms = START_MS;
    const { tables, first } = two_instances();
    const clock = () => new Date(now_ms);
    const created = await new PostgresStaffSessionStore(first, { clock }).create({
      subject_id: "staff-subject-1",
      issuer: "https://idp.test.invalid",
      idp: "supabase",
      has_mfa: true,
      principal: principal_for("1001"),
      device_id: "device-opaque-1",
      ttl_seconds: 300,
    });
    now_ms += 301_000;
    await expect(new PostgresStaffSessionStore(first, { clock }).resolve(created.cookie_value))
      .rejects.toMatchObject({ code: "oauth_session_unavailable" });
    expect(tables.sessions.size).toBe(0);
  });

  it("fails closed on a tampered row rather than producing a partial principal", async () => {
    const { tables, first } = two_instances();
    const clock = () => new Date(START_MS);
    const created = await new PostgresStaffSessionStore(first, { clock }).create({
      subject_id: "staff-subject-1",
      issuer: "https://idp.test.invalid",
      idp: "supabase",
      has_mfa: true,
      principal: principal_for("1001"),
      device_id: "device-opaque-1",
      ttl_seconds: 3_600,
    });
    const row = [...tables.sessions.values()][0] as Record<string, unknown>;
    row.has_mfa = "true";
    await expect(new PostgresStaffSessionStore(first, { clock }).resolve(created.cookie_value))
      .rejects.toMatchObject({ code: "oauth_session_unavailable" });
    row.has_mfa = true;
    row.tenant_roles = "not-json";
    await expect(new PostgresStaffSessionStore(first, { clock }).resolve(created.cookie_value))
      .rejects.toMatchObject({ code: "oauth_membership_unresolved" });
  });
});

