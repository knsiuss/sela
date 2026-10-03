import { describe, expect, it } from "vitest";
import {
  audit_outcome_label,
  AuditTimelineError,
  build_audit_timeline,
  count_new_entries,
  MAX_TIMELINE_ENTRIES,
  type AuditEntry,
} from "../src/domain/audit_timeline.js";
import type { StampedAuditRecord } from "../src/domain/operator_action_gateway.js";

const ALLOWED_KEYS = [
  "action", "actor_subject", "at_iso", "entry_id", "outcome", "reason_code", "request_id", "target_id", "tenant_id",
].sort();

function record(overrides: Partial<StampedAuditRecord> = {}): StampedAuditRecord {
  return {
    tenant_id: "1001",
    actor_subject: "fixture-operator",
    action: "resolve_conflict",
    target_id: "conflict-fixture-pending",
    outcome: "succeeded",
    request_id: "req-1",
    at_iso: "2026-03-02T09:05:00.000Z",
    ...overrides,
  };
}

describe("build_audit_timeline", () => {
  it("projects exactly the redacted field set", () => {
    const entries = build_audit_timeline([record({ reason: "free text that must never surface" } as never)], "1001");
    expect(Object.keys(entries[0]).sort()).toEqual(ALLOWED_KEYS);
  });

  it("keeps foreign-tenant rows out of the timeline", () => {
    const entries = build_audit_timeline([record({ tenant_id: "2002" }), record()], "1001");
    expect(entries).toHaveLength(1);
    expect(entries[0].tenant_id).toBe("1001");
  });

  it("orders newest first", () => {
    const entries = build_audit_timeline([
      record({ request_id: "older", at_iso: "2026-03-02T09:00:00.000Z" }),
      record({ request_id: "newer", at_iso: "2026-03-02T10:00:00.000Z" }),
    ], "1001");
    expect(entries.map((entry) => entry.request_id)).toEqual(["newer", "older"]);
  });

  it("caps the rendered rows", () => {
    const rows = Array.from({ length: MAX_TIMELINE_ENTRIES + 10 }, (_, index) =>
      record({ request_id: `req-${index}`, at_iso: new Date(Date.parse("2026-03-02T09:00:00.000Z") + index * 1000).toISOString() }));
    expect(build_audit_timeline(rows, "1001")).toHaveLength(MAX_TIMELINE_ENTRIES);
  });

  it("assigns a unique entry id to every projected row", () => {
    const entries = build_audit_timeline([
      record({ request_id: "req-a", at_iso: "2026-03-02T09:00:00.000Z" }),
      record({ request_id: "req-b", at_iso: "2026-03-02T10:00:00.000Z" }),
    ], "1001");
    expect(new Set(entries.map((entry) => entry.entry_id)).size).toBe(2);
    expect(entries.every((entry) => typeof entry.entry_id === "string" && entry.entry_id !== "")).toBe(true);
  });

  it("normalises a missing reason code to null", () => {
    expect(build_audit_timeline([record()], "1001")[0].reason_code).toBeNull();
  });

  it("rejects a tenant id the domain would refuse", () => {
    expect(() => build_audit_timeline([record()], "tenant-a")).toThrowError(AuditTimelineError);
  });

  it("rejects a row whose timestamp is not parseable", () => {
    expect(() => build_audit_timeline([record({ at_iso: "nope" })], "1001")).toThrowError(AuditTimelineError);
  });

  it("rejects a row without a usable request id", () => {
    expect(() => build_audit_timeline([record({ request_id: "" })], "1001")).toThrowError(AuditTimelineError);
  });
});

describe("count_new_entries", () => {
  it("counts ids that were not previously announced", () => {
    expect(count_new_entries(["a", "b"], ["a", "b", "c", "d"])).toBe(2);
  });

  it("reports nothing when the timeline is unchanged", () => {
    expect(count_new_entries(["a"], ["a"])).toBe(0);
  });
});

describe("audit_outcome_label", () => {
  it("labels every audited outcome", () => {
    const outcomes: AuditEntry["outcome"][] = ["succeeded", "denied", "failed"];
    expect(outcomes.map(audit_outcome_label)).toEqual(["Succeeded", "Denied", "Failed"]);
  });
});