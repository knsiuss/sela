import { describe, expect, it } from "vitest";
import {
  is_session_revoked,
  list_subject_sessions,
  register_session,
  revoke_session,
  touch_session,
  InMemorySessionRegistry,
  SessionError,
} from "../src/enterprise/session_registry.js";

const CLOCK = () => new Date("2026-09-30T00:00:00.000Z");

describe("session registry", () => {
  it("registers a session with a hashed device id", () => {
    const record = register_session({
      session_id: "sess-1", subject_id: "user-1", tenant_id: "42", device_id: "device-raw-1", clock: CLOCK,
    });
    expect(record.device_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain("device-raw-1");
    expect(is_session_revoked(record)).toBe(false);
  });

  it("touches last-seen and revokes exactly once", () => {
    const record = register_session({
      session_id: "sess-1", subject_id: "user-1", tenant_id: "42", device_id: "d1", clock: CLOCK,
    });
    const touched = touch_session(record, () => new Date("2026-10-01T00:00:00.000Z"));
    expect(touched.last_seen_at_iso).toBe("2026-10-01T00:00:00.000Z");
    const revoked = revoke_session(touched, CLOCK);
    expect(is_session_revoked(revoked)).toBe(true);
    expect(() => revoke_session(revoked, CLOCK)).toThrow("session-already-revoked");
    expect(() => touch_session(revoked, CLOCK)).toThrow("session-revoked");
  });

  it("lists subject history newest first without PII", () => {
    const records = [
      register_session({ session_id: "a", subject_id: "u1", tenant_id: "42", device_id: "d-a", clock: CLOCK }),
      register_session({
        session_id: "b", subject_id: "u1", tenant_id: "42", device_id: "d-b",
        clock: () => new Date("2026-10-02T00:00:00.000Z"),
      }),
    ];
    const history = list_subject_sessions(records, "u1");
    expect(history.map((entry) => entry.session_id)).toEqual(["b", "a"]);
  });

  it("rejects duplicates and bad ids in the store", async () => {
    const registry = new InMemorySessionRegistry();
    await registry.register({ session_id: "s1", subject_id: "u1", tenant_id: "42", device_id: "d", clock: CLOCK });
    await expect(registry.register({ session_id: "s1", subject_id: "u1", tenant_id: "42", device_id: "d", clock: CLOCK }))
      .rejects.toBeInstanceOf(SessionError);
    expect(await registry.get("missing")).toBeNull();
  });
});
