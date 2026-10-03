/**
 * Session cookie, session lifecycle, and MFA-gate coverage.
 *
 * These assertions are the evidence for three separate controls: the cookie is
 * not readable by script and is not sent in the clear; a revoked session really
 * stops working; and a privileged action fails closed when MFA is unverified.
 */

import { describe, expect, it } from "vitest";
import {
  INSECURE_SESSION_COOKIE_NAME,
  SECURE_SESSION_COOKIE_NAME,
  hash_session_secret,
  issue_session_secret,
  parse_session_cookie,
  read_session_cookie_header,
  resolve_session_cookie_policy,
  secret_matches,
  select_session_cookie,
  serialize_session_cookie,
} from "../src/enterprise/oauth/session_cookie.js";
import { InMemoryStaffSessionStore, session_principal } from "../src/enterprise/oauth/staff_session_store.js";
import { OAuthFlowError } from "../src/enterprise/oauth/oauth_error.js";
import {
  authorize,
  authorize_privileged,
  AuthorizationError,
  parse_authenticated_principal,
} from "../src/enterprise/authorization.js";

const START_MS = Date.parse("2026-09-25T00:00:00.000Z");

function principal_with(has_mfa: boolean, tenant_id = "1001") {
  return parse_authenticated_principal({
    subject_id: "staff-subject-1",
    tenant_roles: { [tenant_id]: ["owner"] },
    has_mfa,
    session_id: "session-1",
    issued_at_iso: "2026-09-25T00:00:00.000Z",
  });
}

async function established(has_mfa: boolean) {
  let now_ms = START_MS;
  const store = new InMemoryStaffSessionStore({ clock: () => now_ms });
  const principal = principal_with(has_mfa);
  const session = await store.create({
    subject_id: principal.subject_id,
    issuer: "https://idp.example",
    idp: "supabase",
    has_mfa,
    principal,
    device_id: "device-abc",
    ttl_seconds: 3600,
  });
  return { store, session, principal, advance: (ms: number) => { now_ms += ms; } };
}

describe("session cookie policy", () => {
  it("marks an https session cookie HttpOnly, Secure, SameSite=Lax and __Host- prefixed", () => {
    const policy = resolve_session_cookie_policy({
      public_base_url: "https://staff.example.com",
      allow_insecure_loopback: false,
      session_ttl_seconds: 3600,
    });
    expect(policy.name).toBe(SECURE_SESSION_COOKIE_NAME);
    const issued = issue_session_secret();
    const header = serialize_session_cookie(policy, `${issued.session_id}.${issued.secret}`);
    expect(header).toContain(`${SECURE_SESSION_COOKIE_NAME}=`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=3600");
    // __Host- forbids Domain, so its absence is part of the contract.
    expect(header).not.toContain("Domain=");
  });

  it("refuses to drop Secure for a non-loopback origin even when asked", () => {
    expect(() => resolve_session_cookie_policy({
      public_base_url: "http://staff.example.com",
      allow_insecure_loopback: true,
      session_ttl_seconds: 3600,
    })).toThrow(OAuthFlowError);
  });

  it("refuses an http origin without the explicit loopback opt-in", () => {
    expect(() => resolve_session_cookie_policy({
      public_base_url: "http://127.0.0.1:3000",
      allow_insecure_loopback: false,
      session_ttl_seconds: 3600,
    })).toThrow(OAuthFlowError);
    const opted_in = resolve_session_cookie_policy({
      public_base_url: "http://127.0.0.1:3000",
      allow_insecure_loopback: true,
      session_ttl_seconds: 3600,
    });
    expect(opted_in.name).toBe(INSECURE_SESSION_COOKIE_NAME);
    expect(opted_in.secure).toBe(false);
  });

  it("refuses a TTL outside the bounded window", () => {
    for (const session_ttl_seconds of [299, 86_401, 0, -1, 1.5]) {
      expect(() => resolve_session_cookie_policy({
        public_base_url: "https://staff.example.com",
        allow_insecure_loopback: false,
        session_ttl_seconds,
      })).toThrow(OAuthFlowError);
    }
  });

  it("clears the cookie with the same attributes and a past expiry", () => {
    const policy = resolve_session_cookie_policy({
      public_base_url: "https://staff.example.com",
      allow_insecure_loopback: false,
      session_ttl_seconds: 3600,
    });
    const header = serialize_session_cookie(policy, "", { clear: true });
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
  });

  it("resolves the cookie by policy order, not by header or jar order", () => {
    const secure = resolve_session_cookie_policy({
      public_base_url: "https://staff.example.com",
      allow_insecure_loopback: false,
      session_ttl_seconds: 3600,
    });
    const insecure = resolve_session_cookie_policy({
      public_base_url: "http://127.0.0.1:3000",
      allow_insecure_loopback: true,
      session_ttl_seconds: 3600,
    });
    // A browser can legitimately carry both names; the policy decides, so every
    // surface resolves the same session instead of a different tenant each.
    const both = `${INSECURE_SESSION_COOKIE_NAME}=plain; ${SECURE_SESSION_COOKIE_NAME}=hosted`;
    expect(read_session_cookie_header(both, secure)).toBe("hosted");
    expect(read_session_cookie_header(both, insecure)).toBe("plain");
    const jar = new Map([[INSECURE_SESSION_COOKIE_NAME, "plain"], [SECURE_SESSION_COOKIE_NAME, "hosted"]]);
    expect(select_session_cookie(secure, (name) => jar.get(name))).toBe("hosted");
    expect(select_session_cookie(insecure, (name) => jar.get(name))).toBe("plain");
    expect(read_session_cookie_header(`${INSECURE_SESSION_COOKIE_NAME}=only`, secure)).toBe("only");
    expect(read_session_cookie_header("other=1", secure)).toBeUndefined();
    expect(read_session_cookie_header(null, secure)).toBeUndefined();
  });

  it("mints a fresh id and secret each time and stores only a hash", () => {
    const first = issue_session_secret();
    const second = issue_session_secret();
    expect(first.secret).not.toBe(second.secret);
    expect(first.session_id).not.toBe(second.session_id);
    expect(first.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.secret_hash).not.toBe(first.secret);
    expect(secret_matches(first.secret, first.secret_hash)).toBe(true);
    expect(secret_matches(second.secret, first.secret_hash)).toBe(false);
  });
});

describe("session lifecycle", () => {
  it("resolves a live session and persists a refreshed last-seen time", async () => {
    const { store, session, advance } = await established(true);
    advance(90_000);
    const resolved = await store.resolve(session.cookie_value);
    expect(resolved.subject_id).toBe("staff-subject-1");
    expect(resolved.has_mfa).toBe(true);
    expect(resolved.session.revoked_at_iso).toBeNull();
    expect(resolved.session.device_hash).toMatch(/^[0-9a-f]{64}$/);
    // The returned record is the snapshot taken at resolution time, so the
    // refreshed last-seen is asserted against what the store kept.
    const [stored] = await store.list_subject_sessions("staff-subject-1");
    expect(stored?.session.last_seen_at_iso).toBe(new Date(START_MS + 90_000).toISOString());
    expect(stored?.session.last_seen_at_iso).not.toBe(session.record.session.last_seen_at_iso);
  });

  it("actually stops working after revocation", async () => {
    const { store, session } = await established(true);
    await store.revoke(session.record.session.session_id);
    await expect(store.resolve(session.cookie_value)).rejects.toMatchObject({ code: "oauth_session_unavailable" });
  });

  it("fails closed on a second revocation of the same session", async () => {
    const { store, session } = await established(true);
    await store.revoke(session.record.session.session_id);
    await expect(store.revoke(session.record.session.session_id)).rejects.toBeInstanceOf(OAuthFlowError);
  });

  it("rejects a cookie whose secret does not match the stored session", async () => {
    const { store, session } = await established(true);
    const parsed = parse_session_cookie(session.cookie_value);
    const forged = `${parsed.session_id}.${issue_session_secret().secret}`;
    await expect(store.resolve(forged)).rejects.toMatchObject({ code: "oauth_session_unavailable" });
  });

  it("rejects an unknown session id", async () => {
    const { store } = await established(true);
    const orphan = issue_session_secret();
    await expect(store.resolve(`${orphan.session_id}.${orphan.secret}`)).rejects.toMatchObject({
      code: "oauth_session_unavailable",
    });
  });

  it("expires a session at its TTL rather than keeping it alive", async () => {
    const { store, session, advance } = await established(true);
    advance(3_600_001);
    await expect(store.resolve(session.cookie_value)).rejects.toMatchObject({ code: "oauth_session_unavailable" });
  });

  it("issues a distinct session id per login so a pre-auth id cannot be reused", async () => {
    const { store } = await established(true);
    const login = async () => store.create({
      subject_id: "staff-subject-1",
      issuer: "https://idp.example",
      idp: "supabase",
      has_mfa: true,
      principal: principal_with(true),
      device_id: "device-abc",
      ttl_seconds: 3600,
    });
    const first = await login();
    const second = await login();
    // Both halves of the cookie are drawn fresh at authentication time, so two
    // logins of the same subject share neither the registry id nor the cookie id.
    expect(second.record.session.session_id).not.toBe(first.record.session.session_id);
    expect(second.cookie_value).not.toBe(first.cookie_value);
    expect(second.cookie_value.split(".")[0]).not.toBe(first.cookie_value.split(".")[0]);
    // The stored registry id is derived from both cookie halves, so it is not the
    // raw cookie id a pre-authentication attacker could have guessed.
    expect(second.record.session.session_id).not.toBe(second.cookie_value.split(".")[0]);
    expect(second.record.session.session_id).toContain(second.cookie_value.split(".")[0] as string);
  });

  it("never exposes a raw secret through the stored record", async () => {
    const { session } = await established(true);
    expect(JSON.stringify(session.record)).not.toContain(session.cookie_value.split(".")[1] as string);
    expect(hash_session_secret(session.cookie_value.split(".")[1] as string)).toBe(session.record.secret_hash);
  });

  it("rejects a mismatched MFA claim between the token and the session", async () => {
    const store = new InMemoryStaffSessionStore({ clock: () => START_MS });
    await expect(store.create({
      subject_id: "staff-subject-1",
      issuer: "https://idp.example",
      idp: "supabase",
      has_mfa: true,
      principal: principal_with(false),
      device_id: "device-abc",
      ttl_seconds: 3600,
    })).rejects.toMatchObject({ code: "oauth_identity_unverified" });
  });

  it("rejects a session for a subject with no tenant membership", async () => {
    const store = new InMemoryStaffSessionStore({ clock: () => START_MS });
    await expect(store.create({
      subject_id: "staff-subject-1",
      issuer: "https://idp.example",
      idp: "supabase",
      has_mfa: false,
      principal: parse_authenticated_principal({
        subject_id: "staff-subject-1",
        tenant_roles: {},
        has_mfa: false,
        session_id: "session-1",
        issued_at_iso: "2026-09-25T00:00:00.000Z",
      }),
      device_id: "device-abc",
      ttl_seconds: 3600,
    })).rejects.toMatchObject({ code: "oauth_membership_unresolved" });
  });
});

describe("privileged actions fail closed without verified MFA", () => {
  it("denies replay, cancellation, and tenant management when has_mfa is false", () => {
    const unverified = principal_with(false);
    expect(() => authorize(unverified, "1001", "appointments:reschedule")).not.toThrow();
    for (const permission of ["outbound:replay", "appointments:cancel", "tenant:manage"] as const) {
      expect(() => authorize_privileged(unverified, "1001", permission)).toThrow(AuthorizationError);
      expect(() => authorize_privileged(unverified, "1001", permission)).toThrow(/mfa-required/);
    }
  });

  it("allows those same privileged actions once MFA is verified", () => {
    const verified = principal_with(true);
    for (const permission of ["outbound:replay", "appointments:cancel", "tenant:manage"] as const) {
      expect(() => authorize_privileged(verified, "1001", permission)).not.toThrow();
    }
  });

  it("carries the unverified MFA verdict through the real session store", async () => {
    const { store, session } = await established(false);
    const principal = session_principal(await store.resolve(session.cookie_value));
    expect(principal.has_mfa).toBe(false);
    expect(() => authorize_privileged(principal, "1001", "outbound:replay")).toThrow(/mfa-required/);
  });

  it("projects a verified-MFA session into an authorized principal", async () => {
    const { store, session } = await established(true);
    const principal = session_principal(await store.resolve(session.cookie_value));
    expect(() => authorize_privileged(principal, "1001", "outbound:replay")).not.toThrow();
    expect(() => authorize(principal, "2002", "appointments:read")).toThrow(/forbidden/);
  });

  it("refuses to project a revoked session into a principal", async () => {
    const { store, session } = await established(true);
    const resolved = await store.resolve(session.cookie_value);
    await store.revoke(resolved.session.session_id);
    const revoked = { ...resolved, session: { ...resolved.session, revoked_at_iso: "2026-09-25T00:10:00.000Z" } };
    expect(() => session_principal(revoked)).toThrow(OAuthFlowError);
  });
});
