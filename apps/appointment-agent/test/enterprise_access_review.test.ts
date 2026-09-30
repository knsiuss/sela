import { describe, expect, it } from "vitest";
import { build_access_review, AccessReviewError } from "../src/enterprise/access_review.js";
import { create_api_key } from "../src/enterprise/api_keys.js";
import { register_session } from "../src/enterprise/session_registry.js";
import { invite_user, activate_user, suspend_user } from "../src/enterprise/user_lifecycle.js";

const CLOCK = () => new Date("2026-09-30T00:00:00.000Z");

describe("access review reporting", () => {
  it("counts users, sessions, and keys per tenant", () => {
    const user = activate_user(
      invite_user({ user_id: "user-1", org_id: "org-1", tenant_id: "42", clock: CLOCK }), CLOCK,
    );
    const session = register_session({
      session_id: "sess-1", subject_id: "user-1", tenant_id: "42", device_id: "d1", clock: CLOCK,
    });
    const key = create_api_key({ tenant_id: "42", scopes: ["audit:read"], ttl_days: 30, clock: CLOCK }).record;
    const report = build_access_review("42", { users: [user], sessions: [session], api_keys: [key], clock: CLOCK });
    expect(report).toMatchObject({ active_users: 1, active_sessions: 1, active_api_keys: 1 });
  });

  it("flags stale sessions and suspended users with sessions", () => {
    const user = suspend_user(activate_user(
      invite_user({ user_id: "user-1", org_id: "org-1", tenant_id: "42", clock: CLOCK }), CLOCK,
    ), CLOCK);
    const stale = register_session({
      session_id: "sess-1", subject_id: "user-1", tenant_id: "42", device_id: "d1",
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const report = build_access_review("42", { users: [user], sessions: [stale], api_keys: [], clock: CLOCK });
    expect(report.findings).toContain("stale-session-present");
    expect(report.findings).toContain("suspended-with-session");
  });

  it("scopes counts to the requested tenant and rejects bad input", () => {
    const user = activate_user(
      invite_user({ user_id: "user-9", org_id: "org-1", tenant_id: "43", clock: CLOCK }), CLOCK,
    );
    const report = build_access_review("42", { users: [user], sessions: [], api_keys: [], clock: CLOCK });
    expect(report.active_users).toBe(0);
    expect(() => build_access_review("0", { users: [], sessions: [], api_keys: [] })).toThrow(AccessReviewError);
  });
});
