import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOVERNANCE_CADENCE,
  governance_cadence_statement,
  is_access_review_due,
  is_evidence_export_due,
  resolve_governance_cadence,
} from "../src/enterprise/governance_cadence.js";

describe("governance cadence tunables", () => {
  it("exposes named defaults", () => {
    expect(DEFAULT_GOVERNANCE_CADENCE).toMatchObject({
      evidence_export_days: 7,
      access_review_days: 90,
      retention_check_hours: 24,
    });
    expect(Object.isFrozen(DEFAULT_GOVERNANCE_CADENCE)).toBe(true);
  });

  it("resolves partial overrides and rejects bad bounds", () => {
    expect(resolve_governance_cadence({ evidence_export_days: 14 }).evidence_export_days).toBe(14);
    expect(() => resolve_governance_cadence({ evidence_export_days: 0 })).toThrow();
    expect(() => resolve_governance_cadence({ retention_check_hours: 0 })).toThrow();
  });

  it("computes export and review due dates", () => {
    const now = new Date("2026-09-30T00:00:00.000Z");
    expect(is_evidence_export_due(null, now)).toBe(true);
    expect(is_access_review_due(null, now)).toBe(true);
    expect(is_evidence_export_due("2026-09-29T00:00:00.000Z", now)).toBe(false);
    expect(is_evidence_export_due("2026-09-20T00:00:00.000Z", now)).toBe(true);
    expect(is_access_review_due("2026-09-01T00:00:00.000Z", now)).toBe(false);
    expect(is_access_review_due("2026-01-01T00:00:00.000Z", now)).toBe(true);
  });

  it("renders quotable cadence sentences", () => {
    const lines = governance_cadence_statement(DEFAULT_GOVERNANCE_CADENCE).join("\n");
    expect(lines).toContain("every 7 days");
    expect(lines).toContain("every 90 days");
    expect(lines).toContain("every 24 hours");
  });
});
