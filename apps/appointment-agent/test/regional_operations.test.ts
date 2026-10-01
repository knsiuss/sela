import { describe, expect, it } from "vitest";
import {
  REGIONAL_FAILURE_MATRIX,
  RegionalOperationsError,
  assert_region_permitted,
  plan_region_failure,
  validate_replication_config,
  validate_residency_policy,
} from "../src/enterprise/regional_operations.js";

const POLICY = {
  tenant_id: "42",
  home_region: "ap-southeast-1",
  allowed_regions: ["ap-southeast-1", "ap-southeast-2"],
};

const BASE_REPLICATION = {
  queue_strategy: "at_least_once_single_region",
  database_strategy: "asynchronous_standby",
  max_replication_lag_seconds: 300,
  declared_rpo_minutes: 5,
};

describe("replication strategy validation", () => {
  it("accepts a lag that still meets the declared recovery point", () => {
    expect(validate_replication_config(BASE_REPLICATION)).toMatchObject({
      max_replication_lag_seconds: 300,
      declared_rpo_minutes: 5,
    });
  });

  it("accepts a lag exactly equal to the recovery point", () => {
    expect(() => validate_replication_config(BASE_REPLICATION)).not.toThrow();
  });

  it("rejects a lag that cannot meet the declared recovery point", () => {
    expect(() => validate_replication_config({ ...BASE_REPLICATION, max_replication_lag_seconds: 600 }))
      .toThrow(RegionalOperationsError);
  });

  it("rejects active-active queues without a replicated database", () => {
    expect(() => validate_replication_config({
      ...BASE_REPLICATION,
      queue_strategy: "active_active_multi_region",
      database_strategy: "single_primary_no_replica",
    })).toThrow(RegionalOperationsError);
  });

  it("accepts active-active queues with a replicated database", () => {
    expect(validate_replication_config({
      ...BASE_REPLICATION,
      queue_strategy: "active_active_multi_region",
      database_strategy: "synchronous_multi_primary",
    })).toMatchObject({ queue_strategy: "active_active_multi_region" });
  });

  it.each([
    ["unknown queue strategy", { ...BASE_REPLICATION, queue_strategy: "best_effort" }],
    ["unknown database strategy", { ...BASE_REPLICATION, database_strategy: "magic_mirror" }],
    ["fractional lag", { ...BASE_REPLICATION, max_replication_lag_seconds: 1.5 }],
    ["negative lag", { ...BASE_REPLICATION, max_replication_lag_seconds: -1 }],
    ["zero RPO", { ...BASE_REPLICATION, declared_rpo_minutes: 0 }],
    ["null config", null],
  ])("rejects %s", (_label, config) => {
    expect(() => validate_replication_config(config)).toThrow(RegionalOperationsError);
  });
});

describe("data-residency routing", () => {
  it("accepts a policy whose home region is inside the allowed set", () => {
    expect(validate_residency_policy(POLICY)).toMatchObject({ home_region: "ap-southeast-1" });
  });

  it("rejects a home region outside the allowed set", () => {
    expect(() => validate_residency_policy({ ...POLICY, home_region: "eu-west-1" }))
      .toThrow(RegionalOperationsError);
  });

  it.each([
    ["empty allowed set", { ...POLICY, allowed_regions: [] }],
    ["non-array allowed set", { ...POLICY, allowed_regions: "ap-southeast-1" }],
    ["non-numeric tenant", { ...POLICY, tenant_id: "clinic" }],
    ["malformed region", { ...POLICY, allowed_regions: ["ap_southeast_1"], home_region: "ap_southeast_1" }],
  ])("rejects %s", (_label, policy) => {
    expect(() => validate_residency_policy(policy)).toThrow(RegionalOperationsError);
  });

  it("permits a region inside the boundary and rejects one outside it", () => {
    expect(() => assert_region_permitted(POLICY, "ap-southeast-2")).not.toThrow();
    expect(() => assert_region_permitted(POLICY, "eu-west-1")).toThrow(RegionalOperationsError);
  });
});

describe("regional failure behavior matrix", () => {
  it("keeps the matrix frozen", () => {
    expect(Object.isFrozen(REGIONAL_FAILURE_MATRIX)).toBe(true);
    expect(REGIONAL_FAILURE_MATRIX.database_unavailable).toBe("fail_closed_no_failover");
  });

  it("fails closed on database loss without selecting a target", () => {
    expect(plan_region_failure("database_unavailable", POLICY, "ap-southeast-2")).toEqual({
      mode: "database_unavailable",
      behavior: "fail_closed_no_failover",
      target_region: null,
    });
  });

  it("degrades read-only when only the provider is unreachable", () => {
    expect(plan_region_failure("provider_unreachable", POLICY)).toMatchObject({
      behavior: "degrade_read_only",
      target_region: null,
    });
  });

  it("fails over to a region inside the residency boundary", () => {
    expect(plan_region_failure("region_evicted", POLICY, "ap-southeast-2")).toMatchObject({
      behavior: "failover_to_approved_region",
      target_region: "ap-southeast-2",
    });
  });

  it("refuses to fail over across a residency boundary", () => {
    expect(() => plan_region_failure("region_evicted", POLICY, "eu-west-1")).toThrow(RegionalOperationsError);
  });

  it("requires an explicit target when the behavior fails over", () => {
    expect(() => plan_region_failure("region_evicted", POLICY)).toThrow(RegionalOperationsError);
  });

  it("rejects an unknown failure mode", () => {
    expect(() => plan_region_failure("meteor_strike" as never, POLICY)).toThrow(RegionalOperationsError);
  });
});