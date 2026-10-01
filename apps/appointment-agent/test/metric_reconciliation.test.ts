import { describe, expect, it } from "vitest";
import {
  ArchiveError,
  InMemoryAnalyticsSnapshotStore,
  build_snapshot,
  reconcile_metrics,
  validate_archive_policy,
} from "../src/enterprise/metric_reconciliation.js";

const PERIOD = {
  tenant_id: "42",
  period_start_iso: "2026-09-01T00:00:00.000Z",
  period_end_iso: "2026-10-01T00:00:00.000Z",
  archived_at_iso: "2026-10-01T01:00:00.000Z",
};

describe("metric reconciliation", () => {
  it("reports a matching pair of stores as within tolerance", () => {
    const result = reconcile_metrics(
      { "event_count#action=appointment_booked": 10 },
      { "event_count#action=appointment_booked": 10 },
      0,
    );
    expect(result.is_within_tolerance).toBe(true);
    expect(result.deltas[0]).toMatchObject({ delta: 0, operational_count: 10, analytical_count: 10 });
  });

  it("flags a drift beyond tolerance", () => {
    const result = reconcile_metrics(
      { "event_count#action=appointment_booked": 10 },
      { "event_count#action=appointment_booked": 14 },
      1,
    );
    expect(result.is_within_tolerance).toBe(false);
    expect(result.deltas[0]).toMatchObject({ delta: 4, is_within_tolerance: false });
  });

  it("treats a metric missing from one store as full drift", () => {
    const result = reconcile_metrics({ "event_count#outcome=failed": 3 }, {}, 0);
    expect(result.deltas[0]).toMatchObject({ analytical_count: 0, delta: -3, is_within_tolerance: false });
  });

  it("compares the union of both stores in stable key order", () => {
    const result = reconcile_metrics(
      { "event_count#outcome=failed": 1, "event_count#action=appointment_booked": 1 },
      {},
      0,
    );
    expect(result.deltas.map((entry) => entry.metric_key)).toEqual([
      "event_count#action=appointment_booked",
      "event_count#outcome=failed",
    ]);
  });

  it.each([
    ["unapproved metric", { revenue_by_customer: 1 }, {}],
    ["unapproved action dimension", { "event_count#action=made_up": 1 }, {}],
    ["unapproved outcome dimension", { "event_count#outcome=probably": 1 }, {}],
    ["unapproved length bucket", { "message_length_mix#message_length_bucket=enormous": 1 }, {}],
    ["pseudonymous identifier dimension", { "event_count#sender_ref_hash=abc123": 1 }, {}],
    ["dimension without a value", { "event_count#action": 1 }, {}],
    ["negative count", { "event_count#action=appointment_booked": -1 }, {}],
  ])("rejects a %s", (_label, operational, analytical) => {
    expect(() => reconcile_metrics(operational, analytical, 0)).toThrow(ArchiveError);
  });

  it("rejects a negative tolerance", () => {
    expect(() => reconcile_metrics({}, {}, -1)).toThrow(ArchiveError);
  });
});

describe("archival and restore hooks", () => {
  it("accepts an approved daily retention policy", () => {
    expect(validate_archive_policy({ retention_days: 400, granularity: "daily" }))
      .toMatchObject({ retention_days: 400, granularity: "daily" });
  });

  it.each([
    ["hourly granularity", { retention_days: 30, granularity: "hourly" }],
    ["negative retention", { retention_days: -1, granularity: "daily" }],
    ["fractional retention", { retention_days: 1.5, granularity: "daily" }],
  ])("rejects %s", (_label, policy) => {
    expect(() => validate_archive_policy(policy)).toThrow(ArchiveError);
  });

  it("archives counts without carrying any raw content", () => {
    const snapshot = build_snapshot({
      ...PERIOD,
      counts: { "event_count#action=appointment_booked": 10 },
      policy: { retention_days: 400, granularity: "daily" },
    });
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.counts).toEqual({ "event_count#action=appointment_booked": 10 });
    expect(serialized).not.toMatch(/message_hash|sender_ref_hash|conversation_ref_hash/);
    expect(Object.keys(snapshot)).toEqual([
      "tenant_id",
      "period_start_iso",
      "period_end_iso",
      "counts",
      "archived_at_iso",
    ]);
  });

  it("rejects an inverted archival window", () => {
    expect(() => build_snapshot({
      ...PERIOD,
      period_start_iso: "2026-11-01T00:00:00.000Z",
      counts: {},
      policy: { retention_days: 400, granularity: "daily" },
    })).toThrow(ArchiveError);
  });

  it("rejects archiving a metric key outside the approved set", () => {
    expect(() => build_snapshot({
      ...PERIOD,
      counts: { revenue_by_customer: 5 },
      policy: { retention_days: 400, granularity: "daily" },
    })).toThrow(ArchiveError);
  });

  it("rejects archiving under an unapproved granularity policy", () => {
    expect(() => build_snapshot({
      ...PERIOD,
      counts: { "event_count#action=appointment_booked": 1 },
      policy: { retention_days: 400, granularity: "hourly" } as never,
    })).toThrow(ArchiveError);
  });

  it("round-trips a snapshot through the store and rejects a duplicate period", async () => {
    const store = new InMemoryAnalyticsSnapshotStore();
    const snapshot = build_snapshot({
      ...PERIOD,
      counts: { "event_count#action=appointment_booked": 10 },
      policy: { retention_days: 400, granularity: "daily" },
    });
    await store.save(snapshot);
    await expect(store.load("42", "2026-09-01T00:00:00.000Z")).resolves.toEqual(snapshot);
    await expect(store.save(snapshot)).rejects.toThrow(ArchiveError);
  });

  it("returns null for a period that was never archived", async () => {
    const store = new InMemoryAnalyticsSnapshotStore();
    await expect(store.load("42", "2026-09-01T00:00:00.000Z")).resolves.toBeNull();
  });
});