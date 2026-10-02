import { describe, expect, it } from "vitest";
import { create_workspace_fixture, FIXTURE_TENANT_ID } from "../src/domain/fixtures.js";
import { build_audit_timeline } from "../src/domain/audit_timeline.js";
import {
  create_workspace_snapshot,
  replace_conflict,
  replace_queue_item,
  with_audit_entries,
  with_conflicts,
  with_queue_items,
} from "../src/domain/workspace_state.js";

const NOW_MS = Date.parse("2026-03-02T09:00:00.000Z");

function snapshot() {
  return create_workspace_snapshot(create_workspace_fixture(NOW_MS), FIXTURE_TENANT_ID, NOW_MS);
}

describe("create_workspace_snapshot", () => {
  it("exposes only the scoped tenant's appointments", () => {
    expect(snapshot().appointments.every((row) => row.tenant_id === FIXTURE_TENANT_ID)).toBe(true);
    expect(snapshot().appointments).toHaveLength(5);
  });

  it("reports how many foreign rows tenant scoping removed", () => {
    expect(snapshot().hidden_by_tenant_scope).toBe(2);
  });

  it("records the reference time so SLA rendering stays stable", () => {
    expect(snapshot().now_iso).toBe("2026-03-02T09:00:00.000Z");
  });

  it("starts with an empty audit timeline", () => {
    expect(snapshot().audit_entries).toEqual([]);
  });

  it("copies conflict and queue records instead of aliasing the fixture", () => {
    const created = snapshot();
    const fixture = create_workspace_fixture(NOW_MS);
    expect(created.conflicts[0]).not.toBe(fixture.conflicts[0]);
    expect(created.queue_items[0]).not.toBe(fixture.queue_items[0]);
  });
});

describe("immutable updates", () => {
  it("replaces conflicts without mutating the previous snapshot", () => {
    const before = snapshot();
    const after = with_conflicts(before, []);
    expect(before.conflicts).toHaveLength(5);
    expect(after.conflicts).toHaveLength(0);
    expect(after.tenant_id).toBe(before.tenant_id);
  });

  it("replaces queue items without mutating the previous snapshot", () => {
    const before = snapshot();
    expect(with_queue_items(before, []).queue_items).toHaveLength(0);
    expect(before.queue_items).toHaveLength(6);
  });

  it("replaces audit entries without mutating the previous snapshot", () => {
    const before = snapshot();
    const entries = build_audit_timeline([], FIXTURE_TENANT_ID);
    expect(with_audit_entries(before, entries).audit_entries).toEqual(entries);
    expect(before.audit_entries).toHaveLength(0);
  });

  it("changes only the matching conflict", () => {
    const before = snapshot();
    const target = before.conflicts.find((record) => record.conflict_id === "conflict-fixture-pending");
    if (target === undefined) throw new Error("fixture-missing-conflict");
    const after = replace_conflict(before, { ...target, status: "expired" });
    expect(after.conflicts.find((record) => record.conflict_id === target.conflict_id)?.status).toBe("expired");
    expect(after.conflicts.filter((record) => record.conflict_id !== target.conflict_id)).toEqual(
      before.conflicts.filter((record) => record.conflict_id !== target.conflict_id),
    );
  });

  it("changes only the matching queue item", () => {
    const before = snapshot();
    const target = before.queue_items.find((item) => item.item_id === "queue-fixture-unassigned");
    if (target === undefined) throw new Error("fixture-missing-queue-item");
    const after = replace_queue_item(before, { ...target, status: "resolved" });
    expect(after.queue_items.find((item) => item.item_id === target.item_id)?.status).toBe("resolved");
    expect(before.queue_items.find((item) => item.item_id === target.item_id)?.status).toBe("unassigned");
  });

  it("ignores an update for an id that is not in the snapshot", () => {
    const before = snapshot();
    expect(replace_queue_item(before, {
      item_id: "queue-not-here", tenant_id: FIXTURE_TENANT_ID, status: "unassigned",
      assignee_subject: null, sla_due_at_iso: "2026-03-02T10:00:00.000Z", escalation_level: 0,
      created_at_iso: "2026-03-02T09:00:00.000Z", updated_at_iso: "2026-03-02T09:00:00.000Z",
    })).toEqual(before);
  });
});