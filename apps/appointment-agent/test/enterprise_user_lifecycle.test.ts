import { describe, expect, it } from "vitest";
import {
  activate_user,
  invite_user,
  is_active_user,
  require_tenant_membership,
  revoke_user,
  suspend_user,
  InMemoryUserLifecycleStore,
  UserLifecycleError,
} from "../src/enterprise/user_lifecycle.js";
import { parse_authenticated_principal } from "../src/enterprise/authorization.js";

const CLOCK = () => new Date("2026-09-30T00:00:00.000Z");

describe("user lifecycle state machine", () => {
  it("invites then activates a user", () => {
    const invited = invite_user({ user_id: "user-1", org_id: "org-1", tenant_id: "42", clock: CLOCK });
    expect(invited.status).toBe("invited");
    const active = activate_user(invited, CLOCK);
    expect(active.status).toBe("active");
    expect(is_active_user(active)).toBe(true);
  });

  it("suspends and reactivates an active user", () => {
    const active = activate_user(invite_user({ user_id: "u", org_id: "o", tenant_id: "42", clock: CLOCK }), CLOCK);
    const suspended = suspend_user(active, CLOCK);
    expect(suspended.status).toBe("suspended");
    expect(is_active_user(suspended)).toBe(false);
    expect(activate_user(suspended, CLOCK).status).toBe("active");
  });

  it("revokes from any non-terminal state and blocks further moves", () => {
    const active = activate_user(invite_user({ user_id: "u", org_id: "o", tenant_id: "42", clock: CLOCK }), CLOCK);
    const revoked = revoke_user(active, CLOCK);
    expect(revoked.status).toBe("revoked");
    expect(() => activate_user(revoked, CLOCK)).toThrow(UserLifecycleError);
    expect(() => revoke_user(revoked, CLOCK)).toThrow(UserLifecycleError);
  });

  it("rejects illegal transitions fail-fast", () => {
    const invited = invite_user({ user_id: "u", org_id: "o", tenant_id: "42", clock: CLOCK });
    expect(() => suspend_user(invited, CLOCK)).toThrow("user-suspend-illegal-from-invited");
  });

  it("rejects malformed identifiers", () => {
    expect(() => invite_user({ user_id: "", org_id: "o", tenant_id: "42", clock: CLOCK }))
      .toThrow(UserLifecycleError);
    expect(() => invite_user({ user_id: "u", org_id: "o", tenant_id: "0", clock: CLOCK }))
      .toThrow(UserLifecycleError);
  });

  it("requires tenant membership fail-closed", () => {
    const member = parse_authenticated_principal({
      subject_id: "user-1", session_id: "session-1", has_mfa: false,
      issued_at_iso: "2026-09-30T00:00:00.000Z", tenant_roles: { "42": ["operator"] },
    });
    expect(require_tenant_membership(member, "42")).toBe("42");
    expect(() => require_tenant_membership(member, "43")).toThrow("user-tenant-forbidden");
  });

  it("persists invite and update through the in-memory store", async () => {
    const store = new InMemoryUserLifecycleStore();
    await store.invite({ user_id: "store-1", org_id: "org-1", tenant_id: "42", clock: CLOCK });
    await expect(store.invite({ user_id: "store-1", org_id: "org-1", tenant_id: "42", clock: CLOCK }))
      .rejects.toBeInstanceOf(UserLifecycleError);
    const found = await store.get("store-1");
    expect(found?.status).toBe("invited");
    expect(await store.get("missing")).toBeNull();
  });
});
