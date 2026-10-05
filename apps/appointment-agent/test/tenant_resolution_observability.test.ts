import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricsRegistry } from "../src/observability/metrics.js";
import {
  create_tenant_resolution_tracker,
  log_incomplete_tenant_resolution,
} from "../src/observability/tenant_resolution.js";

const RESOLUTION_METRIC = "webhook_tenant_resolution_total";

describe("create_tenant_resolution_tracker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts resolved events and meters them", () => {
    const metrics = new MetricsRegistry();
    const tracker = create_tenant_resolution_tracker(metrics);

    tracker.record_resolved();
    tracker.record_resolved();

    expect(tracker.total).toBe(0);
    expect(metrics.counter_value(RESOLUTION_METRIC, { result: "resolved" })).toBe(2);
  });

  it("separates an unreadable channel account from an unknown channel", () => {
    const metrics = new MetricsRegistry();
    const tracker = create_tenant_resolution_tracker(metrics);

    tracker.record("");
    tracker.record("106540352242922");

    expect(tracker.total).toBe(2);
    expect(tracker.missing_account_count).toBe(1);
    expect(tracker.unknown_channel_count).toBe(1);
    expect(metrics.counter_value(RESOLUTION_METRIC, { result: "channel_account_missing" })).toBe(1);
    expect(metrics.counter_value(RESOLUTION_METRIC, { result: "unknown_channel" })).toBe(1);
  });

  it("still counts outcomes when no metrics sink is configured", () => {
    const tracker = create_tenant_resolution_tracker(undefined);

    tracker.record("");
    tracker.record("106540352242922");
    tracker.record_resolved();

    expect(tracker.total).toBe(2);
    expect(tracker.missing_account_count).toBe(1);
    expect(tracker.unknown_channel_count).toBe(1);
  });
});

describe("log_incomplete_tenant_resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture(tracker: ReturnType<typeof create_tenant_resolution_tracker>): Record<string, unknown>[] {
    const warn_spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      log_incomplete_tenant_resolution("2f1c0f6e-6c4a-4a1e-9a0a-6d1b2c3d4e5f", tracker);
      return warn_spy.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
    } finally {
      warn_spy.mockRestore();
    }
  }

  it("stays silent when every event resolved", () => {
    const tracker = create_tenant_resolution_tracker(undefined);
    tracker.record_resolved();
    expect(capture(tracker)).toEqual([]);
  });

  it("names the missing-account reason without the account id", () => {
    const tracker = create_tenant_resolution_tracker(undefined);
    tracker.record("");
    const [line] = capture(tracker);

    expect(line).toMatchObject({
      event: "webhook_tenant_resolution_incomplete",
      request_id: "2f1c0f6e-6c4a-4a1e-9a0a-6d1b2c3d4e5f",
      reason: "channel_account_missing",
      unresolved_count: 1,
    });
    expect(Object.keys(line!).sort()).toEqual(["event", "reason", "request_id", "unresolved_count"]);
  });

  it("joins both reasons when a delivery mixed them", () => {
    const tracker = create_tenant_resolution_tracker(undefined);
    tracker.record("");
    tracker.record("106540352242922");
    const [line] = capture(tracker);

    expect(line).toMatchObject({
      reason: "channel_account_missing+unknown_channel",
      unresolved_count: 2,
    });
    expect(JSON.stringify(line)).not.toContain("106540352242922");
  });
});