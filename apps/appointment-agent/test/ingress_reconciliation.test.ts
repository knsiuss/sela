import { describe, expect, it } from "vitest";
import {
  classify_ingress_state,
  detect_orphans,
  IngressReconciliationError,
  repair_age_exceeded,
  support_replay_guidance,
  type IngressTriple,
} from "../src/ingress/reconciliation.js";
import { ingress_triple } from "./helpers/ingress_fixture.js";

const NOW = new Date("2026-09-24T08:30:00.000Z");

describe("classify_ingress_state", () => {
  it("accepts an active job with a processed retained row", () => {
    expect(classify_ingress_state({
      has_claim: true,
      has_inbound_row: true,
      job_status: "pending",
      inbound_processed: true,
    })).toBe("accepted");
  });

  it("keeps an active job with an unprocessed row reconciling", () => {
    expect(classify_ingress_state({
      has_claim: true,
      has_inbound_row: true,
      job_status: "claimed",
      inbound_processed: false,
    })).toBe("reconciling");
  });

  it("treats terminal jobs with retained rows as duplicates", () => {
    for (const job_status of ["completed", "failed"] as const) {
      expect(classify_ingress_state({
        has_claim: true,
        has_inbound_row: true,
        job_status,
        inbound_processed: true,
      })).toBe("duplicate");
    }
  });

  it("flags a terminal job without a retained row for repair", () => {
    expect(classify_ingress_state({
      has_claim: true,
      has_inbound_row: false,
      job_status: "completed",
      inbound_processed: false,
    })).toBe("needs_repair");
  });

  it("flags an active job without a retained row for repair", () => {
    expect(classify_ingress_state({
      has_claim: true,
      has_inbound_row: false,
      job_status: "pending",
      inbound_processed: false,
    })).toBe("needs_repair");
  });

  it("flags a claim without any worker job for repair", () => {
    expect(classify_ingress_state({
      has_claim: true,
      has_inbound_row: false,
      job_status: "missing",
      inbound_processed: false,
    })).toBe("needs_repair");
  });

  it("keeps provider-accepted residue without a visible claim reconciling", () => {
    expect(classify_ingress_state({
      has_claim: false,
      has_inbound_row: true,
      job_status: "pending",
      inbound_processed: false,
    })).toBe("reconciling");
  });

  it("rejects invalid evidence fail-closed", () => {
    expect(() => classify_ingress_state({
      has_claim: true,
      has_inbound_row: true,
      job_status: "unknown_state",
      inbound_processed: false,
    } as unknown as Parameters<typeof classify_ingress_state>[0])).toThrow(IngressReconciliationError);
  });
});

describe("detect_orphans", () => {
  it("reports only non-healthy triples with structural kinds", () => {
    const reports = detect_orphans([
      ingress_triple({ wamid: "wamid-healthy", inbound_processed: true }),
      ingress_triple({ wamid: "wamid-claim-only", has_inbound_row: false, job_status: "missing" }),
      ingress_triple({ wamid: "wamid-job-only", has_inbound_row: false, job_status: "pending" }),
      ingress_triple({
        wamid: "wamid-residue",
        has_inbound_row: true,
        job_status: "missing",
        inbound_processed: false,
      }),
      ingress_triple({ wamid: "wamid-terminal", job_status: "completed", inbound_processed: true }),
      ingress_triple({ wamid: "wamid-inflight", inbound_processed: false }),
    ]);
    expect(reports.map((report) => [report.wamid, report.kind, report.status])).toEqual([
      ["wamid-claim-only", "claim_without_job", "needs_repair"],
      ["wamid-job-only", "job_without_row", "needs_repair"],
      ["wamid-residue", "uncommitted_residue", "needs_repair"],
      ["wamid-inflight", "uncommitted_residue", "reconciling"],
    ]);
  });

  it("enforces bounded batches and rejects invalid limits", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ingress_triple({ wamid: `wamid-${index}` }));
    expect(detect_orphans(rows, { limit: 2 })).toHaveLength(2);
    expect(() => detect_orphans(rows, { limit: 0 })).toThrow(IngressReconciliationError);
    expect(() => detect_orphans(rows, { limit: 10_001 })).toThrow(IngressReconciliationError);
  });

  it("fails closed on malformed triples without skipping silently", () => {
    expect(() => detect_orphans([
      { tenant_id: "", wamid: "wamid-bad" } as unknown as IngressTriple,
    ])).toThrow(IngressReconciliationError);
  });
});

describe("repair_age_exceeded", () => {
  it("fires only past the paging threshold", () => {
    expect(repair_age_exceeded("2026-09-24T08:20:00.000Z", NOW, 15 * 60 * 1000)).toBe(false);
    expect(repair_age_exceeded("2026-09-24T07:00:00.000Z", NOW, 15 * 60 * 1000)).toBe(true);
  });

  it("rejects invalid timestamps and thresholds", () => {
    expect(() => repair_age_exceeded("not-a-date", NOW)).toThrow(IngressReconciliationError);
    expect(() => repair_age_exceeded("2026-09-24T08:00:00.000Z", NOW, -1)).toThrow(
      IngressReconciliationError,
    );
  });
});

describe("support_replay_guidance", () => {
  it("returns safe manual replay guidance per orphan kind", () => {
    for (const kind of ["claim_without_job", "job_without_row", "uncommitted_residue"] as const) {
      const guidance = support_replay_guidance(kind);
      expect(guidance.length).toBeGreaterThan(20);
      expect(guidance).not.toMatch(/\+?\d[\d\s-]{7,}/);
    }
    expect(() => support_replay_guidance("unknown" as never)).toThrow(IngressReconciliationError);
  });
});
