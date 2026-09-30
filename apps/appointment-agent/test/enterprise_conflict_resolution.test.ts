import { describe, expect, it } from "vitest";
import { parse_authenticated_principal } from "../src/enterprise/authorization.js";
import {
  accept_resolution,
  expire_conflict,
  open_conflict,
  propose_resolution,
  reject_resolution,
  InMemoryConflictStore,
  ConflictError,
} from "../src/enterprise/conflict_resolution.js";

function principal(has_mfa = true) {
  return parse_authenticated_principal({
    subject_id: "op-1", session_id: "s-1", has_mfa,
    issued_at_iso: "2026-09-30T00:00:00.000Z", tenant_roles: { "42": ["operator"] },
  });
}

describe("conflict resolution state machine", () => {
  it("opens pending then proposes a slot", () => {
    const pending = open_conflict({
      conflict_id: "c-1", tenant_id: "42", appointment_id: "appt-1", generation: 3,
      clock: () => new Date("2026-09-30T00:00:00.000Z"),
    });
    expect(pending.status).toBe("pending");
    const proposed = propose_resolution(pending, "2026-10-01T10:00:00.000Z", principal(), "42");
    expect(proposed).toMatchObject({ status: "proposed", proposed_slot_iso: "2026-10-01T10:00:00.000Z" });
  });

  it("accepts with mfa and matching generation", () => {
    const pending = open_conflict({ conflict_id: "c-1", tenant_id: "42", appointment_id: "a", generation: 2 });
    const proposed = propose_resolution(pending, "2026-10-01T10:00:00.000Z", principal(), "42");
    const accepted = accept_resolution(proposed, principal(), "42", 2);
    expect(accepted.status).toBe("accepted");
    expect(() => accept_resolution(accepted, principal(), "42", 2))
      .toThrow("conflict-accept-illegal-from-accepted");
  });

  it("requires mfa for accept and rejects stale generations", () => {
    const pending = open_conflict({ conflict_id: "c-1", tenant_id: "42", appointment_id: "a", generation: 5 });
    const proposed = propose_resolution(pending, "2026-10-01T10:00:00.000Z", principal(), "42");
    expect(() => accept_resolution(proposed, principal(false), "42", 5)).toThrow("conflict-mfa-required");
    expect(() => accept_resolution(proposed, principal(), "42", 4)).toThrow("conflict-generation-stale");
  });

  it("rejects from pending or proposed and expires past deadline", () => {
    const pending = open_conflict({ conflict_id: "c-1", tenant_id: "42", appointment_id: "a", generation: 1 });
    expect(reject_resolution(pending, principal(), "42").status).toBe("rejected");
    const expiring = open_conflict({
      conflict_id: "c-2", tenant_id: "42", appointment_id: "a", generation: 1, ttl_minutes: 1,
      clock: () => new Date("2026-09-30T00:00:00.000Z"),
    });
    expect(expire_conflict(expiring, new Date("2026-09-30T02:00:00.000Z")).status).toBe("expired");
    expect(expire_conflict(expiring, new Date("2026-09-30T00:00:30.000Z")).status).toBe("pending");
  });

  it("persists records through the in-memory store", async () => {
    const store = new InMemoryConflictStore();
    const pending = open_conflict({ conflict_id: "store-1", tenant_id: "42", appointment_id: "a", generation: 1 });
    await store.save(pending);
    expect((await store.get("store-1"))?.status).toBe("pending");
    expect(await store.get("missing")).toBeNull();
  });

  it("rejects illegal propose paths fail-fast", () => {
    const pending = open_conflict({ conflict_id: "c-1", tenant_id: "42", appointment_id: "a", generation: 1 });
    const rejected = reject_resolution(pending, principal(), "42");
    expect(() => propose_resolution(rejected, "2026-10-01T10:00:00.000Z", principal(), "42"))
      .toThrow(ConflictError);
  });
});
