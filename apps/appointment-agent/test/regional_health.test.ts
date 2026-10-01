import { describe, expect, it } from "vitest";
import {
  HealthCheckInput,
  RegionalHealthError,
  REQUIRED_HEALTH_CHECKS,
  evaluate_region_health,
} from "../src/enterprise/regional_health.js";

const HEALTHY_CHECKS: readonly HealthCheckInput[] = [
  { kind: "database", is_healthy: true, detail_code: "pool_ok" },
  { kind: "queue_depth", is_healthy: true, detail_code: "depth_ok" },
  { kind: "provider_reachable", is_healthy: true, detail_code: "reachable" },
  { kind: "clock_skew", is_healthy: true, detail_code: "skew_ok" },
];

function checks_with_failure(kind: HealthCheckInput["kind"]): readonly HealthCheckInput[] {
  return HEALTHY_CHECKS.map((check) => (check.kind === kind ? { ...check, is_healthy: false } : check));
}

describe("regional health evaluation", () => {
  it("reports healthy when every required check passes", () => {
    const report = evaluate_region_health("ap-southeast-1", HEALTHY_CHECKS);
    expect(report.state).toBe("healthy");
    expect(report.failing_kinds).toEqual([]);
    expect(report.checks.every((check) => check.is_required)).toBe(true);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it("degrades when a non-database component fails", () => {
    const report = evaluate_region_health("ap-southeast-1", checks_with_failure("provider_reachable"));
    expect(report.state).toBe("degraded");
    expect(report.failing_kinds).toEqual(["provider_reachable"]);
  });

  it("reports unhealthy when the database check fails", () => {
    const report = evaluate_region_health("ap-southeast-1", checks_with_failure("database"));
    expect(report.state).toBe("unhealthy");
  });

  it("fails closed when a required check is missing", () => {
    const partial = HEALTHY_CHECKS.slice(0, REQUIRED_HEALTH_CHECKS.length - 1);
    const report = evaluate_region_health("ap-southeast-1", partial);
    expect(report.state).toBe("unhealthy");
    expect(report.failing_kinds).toEqual([]);
  });

  it("treats a non-boolean health flag as unhealthy", () => {
    const coerced = HEALTHY_CHECKS.map((check) => (check.kind === "queue_depth"
      ? ({ ...check, is_healthy: "yes" } as unknown as HealthCheckInput)
      : check));
    expect(evaluate_region_health("ap-southeast-1", coerced).state).toBe("degraded");
  });

  it.each([
    ["empty probe set", []],
    ["unknown kind", [{ kind: "gpu_thermals", is_healthy: true, detail_code: "ok" }]],
    ["duplicate kind", [HEALTHY_CHECKS[0], HEALTHY_CHECKS[0]]],
    ["non-slug detail", [{ kind: "database", is_healthy: true, detail_code: "pool ok; user=1" }]],
    ["detail carrying a control character", [{
      kind: "database",
      is_healthy: true,
      detail_code: `pool_${String.fromCharCode(10)}ok`,
    }]],
    ["null probe", [null]],
  ])("rejects %s", (_label, inputs) => {
    expect(() => evaluate_region_health("ap-southeast-1", inputs as never)).toThrow(RegionalHealthError);
  });

  it.each(["AP-SOUTHEAST-1", "ap_southeast_1", "southeast", ""])("rejects region name %s", (region) => {
    expect(() => evaluate_region_health(region, HEALTHY_CHECKS)).toThrow(RegionalHealthError);
  });
});