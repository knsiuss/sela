import { describe, expect, it } from "vitest";
import {
  CapacityBounds,
  TrafficEstimate,
  TrafficModelError,
  derive_peak_limits,
  validate_traffic_estimate,
} from "../src/enterprise/traffic_model.js";

const BASE_ESTIMATE = {
  tenant_id: "42",
  location_id: "clinic-1",
  messages_per_day: 100_000,
  appointments_per_day: 5_000,
  peak_factor: 3,
  channel: "whatsapp",
} as const;

const BASE_BOUNDS: CapacityBounds = {
  peak_webhook_rps: 10,
  peak_worker_jobs_per_second: 10,
  database_pool_max: 20,
  provider_mps: 10_000,
};

describe("traffic model peak limits", () => {
  it("normalizes a valid estimate into a frozen copy", () => {
    const estimate = validate_traffic_estimate(BASE_ESTIMATE);
    expect(estimate).toMatchObject({ tenant_id: "42", channel: "whatsapp" });
    expect(Object.isFrozen(estimate)).toBe(true);
  });

  it("derives per-minute provider and webhook rates inside every bound", () => {
    const limits = derive_peak_limits(BASE_ESTIMATE, BASE_BOUNDS);
    expect(limits).toEqual({
      webhook_rps: 4,
      worker_jobs_per_second: 4,
      db_connections: 8,
      provider_mps: 5_000,
    });
  });

  it("never derives a rate below one unit per second", () => {
    const minimal: TrafficEstimate = validate_traffic_estimate({
      ...BASE_ESTIMATE,
      messages_per_day: 1,
      appointments_per_day: 0,
      peak_factor: 1,
    });
    expect(derive_peak_limits(minimal, BASE_BOUNDS)).toMatchObject({
      webhook_rps: 1,
      worker_jobs_per_second: 1,
      db_connections: 2,
      provider_mps: 1,
    });
  });

  it("fails closed instead of clamping a webhook rate above the bound", () => {
    expect(() => derive_peak_limits(BASE_ESTIMATE, { ...BASE_BOUNDS, peak_webhook_rps: 3 }))
      .toThrow(TrafficModelError);
  });

  it("rejects a provider rate above the per-minute bound", () => {
    expect(() => derive_peak_limits(BASE_ESTIMATE, { ...BASE_BOUNDS, provider_mps: 4_999 }))
      .toThrow(TrafficModelError);
  });

  it("rejects connection demand above the database pool", () => {
    expect(() => derive_peak_limits(BASE_ESTIMATE, { ...BASE_BOUNDS, database_pool_max: 7 }))
      .toThrow(TrafficModelError);
  });

  it("rejects control characters in a location identifier", () => {
    const injected = String.fromCharCode(7);
    expect(() => validate_traffic_estimate({ ...BASE_ESTIMATE, location_id: `clinic${injected}1` }))
      .toThrow(TrafficModelError);
  });
});

describe("traffic model input validation", () => {
  it.each([
    ["non-object input", "not-an-object"],
    ["null input", null],
  ])("rejects %s", (_label, value) => {
    expect(() => validate_traffic_estimate(value)).toThrow(TrafficModelError);
  });

  it.each([
    ["non-numeric tenant", { ...BASE_ESTIMATE, tenant_id: "clinic" }],
    ["zero-padded tenant", { ...BASE_ESTIMATE, tenant_id: "042" }],
    ["empty location", { ...BASE_ESTIMATE, location_id: "" }],
    ["untrimmed location", { ...BASE_ESTIMATE, location_id: " clinic-1" }],
    ["unknown channel", { ...BASE_ESTIMATE, channel: "carrier-pigeon" }],
    ["zero message volume", { ...BASE_ESTIMATE, messages_per_day: 0 }],
    ["fractional message volume", { ...BASE_ESTIMATE, messages_per_day: 1.5 }],
    ["negative appointments", { ...BASE_ESTIMATE, appointments_per_day: -1 }],
    ["peak factor below one", { ...BASE_ESTIMATE, peak_factor: 0.5 }],
    ["peak factor above ten", { ...BASE_ESTIMATE, peak_factor: 11 }],
  ])("rejects %s", (_label, value) => {
    expect(() => validate_traffic_estimate(value)).toThrow(TrafficModelError);
  });

  it("rejects an out-of-range capacity bound instead of trusting it", () => {
    expect(() => derive_peak_limits(BASE_ESTIMATE, { ...BASE_BOUNDS, database_pool_max: 0 }))
      .toThrow(TrafficModelError);
  });

  it("carries a sanitized error code and message", () => {
    try {
      validate_traffic_estimate(null);
      throw new Error("expected-validation-failure");
    } catch (error) {
      expect(error).toMatchObject({ name: "TrafficModelError", code: "traffic_model_invalid" });
      expect((error as Error).message).toBe("traffic-model-invalid");
    }
  });
});