import { describe, expect, it } from "vitest";
import {
  allowed_conflict_actions,
  apply_conflict_action,
  conflict_status_label,
  count_open_conflicts,
  expire_due_conflicts,
  type ConflictRecord,
} from "../src/domain/conflict_board.js";
import { create_workspace_fixture, FIXTURE_TENANT_ID } from "../src/domain/fixtures.js";
import { build_local_principal, type LocalPrincipalClaims, to_wire_principal } from "../src/domain/synthetic_principal.js";
import { parse_authenticated_principal } from "appointment-agent/dist/src/enterprise/authorization.js";

const NOW_MS = Date.parse("2026-03-02T09:00:00.000Z");

function conflict(conflict_id: string): ConflictRecord {
  const found = create_workspace_fixture(NOW_MS).conflicts.find((record) => record.conflict_id === conflict_id);
  if (found === undefined) throw new Error(`fixture-missing-${conflict_id}`);
  return found;
}

function principal(role: "operator" | "support" | "owner" = "operator", has_mfa = true) {
  const claims: LocalPrincipalClaims = to_wire_principal(build_local_principal(FIXTURE_TENANT_ID, role));
  return parse_authenticated_principal({ ...claims, has_mfa });
}

describe("allowed_conflict_actions", () => {
  it("offers propose and reject while a conflict is pending", () => {
    expect(allowed_conflict_actions(conflict("conflict-fixture-pending"), principal(), FIXTURE_TENANT_ID))
      .toEqual(["propose", "reject"]);
  });

  it("offers accept and reject once a slot is proposed", () => {
    expect(allowed_conflict_actions(conflict("conflict-fixture-proposed"), principal(), FIXTURE_TENANT_ID))
      .toEqual(["accept", "reject"]);
  });

  it("withholds accept when the principal has no MFA claims", () => {
    expect(allowed_conflict_actions(conflict("conflict-fixture-proposed"), principal("operator", false), FIXTURE_TENANT_ID))
      .toEqual(["reject"]);
  });

  it("offers nothing for a terminal conflict", () => {
    for (const id of ["conflict-fixture-accepted", "conflict-fixture-rejected", "conflict-fixture-expired"]) {
      expect(allowed_conflict_actions(conflict(id), principal(), FIXTURE_TENANT_ID)).toEqual([]);
    }
  });

  it("offers nothing when the role cannot reschedule appointments", () => {
    expect(allowed_conflict_actions(conflict("conflict-fixture-pending"), principal("support"), FIXTURE_TENANT_ID))
      .toEqual([]);
  });

  it("offers nothing for a conflict owned by another tenant", () => {
    expect(allowed_conflict_actions(conflict("conflict-fixture-pending"), principal(), "2002")).toEqual([]);
  });
});

describe("apply_conflict_action", () => {
  it("moves a pending conflict to proposed with the chosen slot", () => {
    const outcome = apply_conflict_action(
      conflict("conflict-fixture-pending"), "propose", principal(), FIXTURE_TENANT_ID,
      { proposed_slot_iso: "2026-03-05T10:00:00.000Z" },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.record.status).toBe("proposed");
      expect(outcome.record.proposed_slot_iso).toBe("2026-03-05T10:00:00.000Z");
    }
  });

  it("reports the domain code when proposing from a proposed conflict", () => {
    const outcome = apply_conflict_action(
      conflict("conflict-fixture-proposed"), "propose", principal(), FIXTURE_TENANT_ID,
      { proposed_slot_iso: "2026-03-05T10:00:00.000Z" },
    );
    expect(outcome).toEqual({ ok: false, code: "conflict-propose-illegal-from-proposed" });
  });

  it("reports the domain code when the requested slot is not a valid timestamp", () => {
    const outcome = apply_conflict_action(
      conflict("conflict-fixture-pending"), "propose", principal(), FIXTURE_TENANT_ID,
      { proposed_slot_iso: "not-a-time" },
    );
    expect(outcome).toEqual({ ok: false, code: "conflict-slot-invalid" });
  });

  it("refuses to propose without a slot instead of inventing one", () => {
    expect(apply_conflict_action(conflict("conflict-fixture-pending"), "propose", principal(), FIXTURE_TENANT_ID))
      .toEqual({ ok: false, code: "conflict-slot-required" });
  });

  it("accepts a proposed conflict with a matching generation", () => {
    const record = conflict("conflict-fixture-proposed");
    const outcome = apply_conflict_action(record, "accept", principal(), FIXTURE_TENANT_ID, { generation: record.generation });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.record.status).toBe("accepted");
      expect(outcome.record.decided_at_iso).not.toBeNull();
    }
  });

  it("reports a stale generation instead of accepting a newer decision", () => {
    const record = conflict("conflict-fixture-proposed");
    const outcome = apply_conflict_action(record, "accept", principal(), FIXTURE_TENANT_ID, { generation: record.generation + 1 });
    expect(outcome).toEqual({ ok: false, code: "conflict-generation-stale" });
  });

  it("requires MFA to accept a resolution", () => {
    const record = conflict("conflict-fixture-proposed");
    expect(apply_conflict_action(record, "accept", principal("operator", false), FIXTURE_TENANT_ID, { generation: record.generation }))
      .toEqual({ ok: false, code: "conflict-mfa-required" });
  });

  it("rejects from pending and from proposed", () => {
    for (const id of ["conflict-fixture-pending", "conflict-fixture-proposed"]) {
      const outcome = apply_conflict_action(conflict(id), "reject", principal(), FIXTURE_TENANT_ID);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.record.status).toBe("rejected");
    }
  });

  it("refuses a cross-tenant transition before reaching the domain", () => {
    expect(apply_conflict_action(conflict("conflict-fixture-pending"), "reject", principal(), "2002"))
      .toEqual({ ok: false, code: "conflict-tenant-mismatch" });
  });

  it("never throws for a role without reschedule rights", () => {
    expect(apply_conflict_action(conflict("conflict-fixture-pending"), "reject", principal("support"), FIXTURE_TENANT_ID))
      .toEqual({ ok: false, code: "authorization-forbidden" });
  });
});

describe("expire_due_conflicts", () => {
  it("expires a pending conflict whose deadline has passed", () => {
    const records = create_workspace_fixture(NOW_MS).conflicts;
    const expired = expire_due_conflicts(records, new Date(NOW_MS + 10_000_000));
    expect(expired.find((record) => record.conflict_id === "conflict-fixture-pending")?.status).toBe("expired");
  });

  it("leaves a conflict untouched before its deadline", () => {
    const records = create_workspace_fixture(NOW_MS).conflicts;
    const swept = expire_due_conflicts(records, new Date(NOW_MS));
    expect(swept.find((record) => record.conflict_id === "conflict-fixture-pending")?.status).toBe("pending");
  });

  it("does not change terminal conflicts", () => {
    const records = create_workspace_fixture(NOW_MS).conflicts;
    const swept = expire_due_conflicts(records, new Date(NOW_MS + 10_000_000));
    expect(swept.find((record) => record.conflict_id === "conflict-fixture-accepted")?.status).toBe("accepted");
  });
});

describe("count_open_conflicts", () => {
  it("counts pending and proposed conflicts only", () => {
    expect(count_open_conflicts(create_workspace_fixture(NOW_MS).conflicts)).toBe(2);
  });
});

describe("conflict_status_label", () => {
  it("labels every lifecycle status", () => {
    expect(conflict_status_label("pending")).toBe("Pending");
    expect(conflict_status_label("expired")).toBe("Expired");
  });
});