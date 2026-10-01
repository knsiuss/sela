/** Replication, data-residency, and regional-failure routing contracts. */

/** Queue replication posture; single-region delivery stays at-least-once. */
export type QueueReplicationStrategy = "at_least_once_single_region" | "active_active_multi_region";

/** Database replication posture and the durability each posture implies. */
export type DatabaseReplicationStrategy =
  | "synchronous_multi_primary"
  | "asynchronous_standby"
  | "single_primary_no_replica";

/** Declared replication posture bounded by an agreed recovery point. */
export interface ReplicationConfig {
  queue_strategy: QueueReplicationStrategy;
  database_strategy: DatabaseReplicationStrategy;
  max_replication_lag_seconds: number;
  declared_rpo_minutes: number;
}

/** Data-residency boundary pinned to one tenant. */
export interface ResidencyPolicy {
  tenant_id: string;
  home_region: string;
  allowed_regions: readonly string[];
}

/** Ways a region can stop serving. */
export type RegionFailureMode = "database_unavailable" | "queue_unavailable" | "provider_unreachable" | "region_evicted";

/** Required operator/system behavior for each failure mode. */
export type FailureBehavior = "fail_closed_no_failover" | "failover_to_approved_region" | "degrade_read_only";

/**
 * Frozen regional-failure behavior matrix.
 *
 * Database or queue loss must never silently continue: losing the primary or
 * the job store risks lost or duplicated bookings, which outranks availability,
 * so those modes fail closed instead of moving traffic.
 */
export const REGIONAL_FAILURE_MATRIX: Readonly<Record<RegionFailureMode, FailureBehavior>> = Object.freeze({
  database_unavailable: "fail_closed_no_failover",
  queue_unavailable: "fail_closed_no_failover",
  provider_unreachable: "degrade_read_only",
  region_evicted: "failover_to_approved_region",
});

/** Resolved behavior for one failure, including the region it may use. */
export interface FailureAction {
  mode: RegionFailureMode;
  behavior: FailureBehavior;
  /** Null whenever the behavior must not move traffic to another region. */
  target_region: string | null;
}

/** Safe failure for an unbuildable regional contract. */
export class RegionalOperationsError extends Error {
  readonly code = "regional_operations_invalid";

  /** Create a sanitized regional-operations failure. */
  constructor(reason: string) {
    super(reason);
    this.name = "RegionalOperationsError";
  }
}

const SECONDS_PER_MINUTE = 60;
const MAX_REPLICATION_LAG_SECONDS = 86_400;

/**
 * Validate replication posture against the declared recovery point.
 *
 * Replication lag is the floor the recovery point can actually achieve, so a
 * lag larger than the declared RPO is rejected at configuration time instead of
 * being discovered during an incident.
 *
 * @param value - Candidate replication configuration.
 * @returns Frozen validated configuration.
 */
export function validate_replication_config(value: unknown): ReplicationConfig {
  if (typeof value !== "object" || value === null) throw new RegionalOperationsError("replication-config-invalid");
  const record = value as Record<string, unknown>;
  const config: ReplicationConfig = {
    queue_strategy: one_of(record.queue_strategy, QUEUE_STRATEGIES, "replication-queue-strategy-invalid"),
    database_strategy: one_of(record.database_strategy, DATABASE_STRATEGIES, "replication-database-strategy-invalid"),
    max_replication_lag_seconds: bounded_integer(
      record.max_replication_lag_seconds,
      0,
      MAX_REPLICATION_LAG_SECONDS,
      "replication-lag-invalid",
    ),
    declared_rpo_minutes: bounded_integer(record.declared_rpo_minutes, 1, 100_000, "replication-rpo-invalid"),
  };
  if (implied_rpo_minutes(config) > config.declared_rpo_minutes) {
    throw new RegionalOperationsError("replication-lag-exceeds-rpo");
  }
  if (config.queue_strategy === "active_active_multi_region" && !is_multi_region(config.database_strategy)) {
    throw new RegionalOperationsError("replication-queue-database-mismatch");
  }
  return Object.freeze(config);
}

/**
 * Validate a data-residency policy.
 *
 * Region identifiers are format-checked only: the approved residency regions
 * are still an open product decision, so this contract cannot hardcode them.
 *
 * @param value - Candidate residency policy.
 * @returns Frozen validated policy.
 */
export function validate_residency_policy(value: unknown): ResidencyPolicy {
  if (typeof value !== "object" || value === null) throw new RegionalOperationsError("residency-policy-invalid");
  const record = value as Record<string, unknown>;
  const allowed = record.allowed_regions;
  if (!Array.isArray(allowed) || allowed.length < 1 || allowed.length > 32) {
    throw new RegionalOperationsError("residency-regions-invalid");
  }
  const allowed_regions = Object.freeze(allowed.map((region) => region_name_value(region)));
  const home_region = region_name_value(record.home_region);
  if (!allowed_regions.includes(home_region)) throw new RegionalOperationsError("residency-home-region-allowed");
  return Object.freeze({ tenant_id: tenant_id_value(record.tenant_id), home_region, allowed_regions });
}

/**
 * Decide how a region failure must be handled for one tenant.
 *
 * Failover may only target a region inside the tenant's residency boundary, so
 * a cross-region target is rejected rather than accepted and then violated by
 * the data it carries.
 *
 * @param mode - Detected regional failure mode.
 * @param policy - Residency policy for the affected tenant.
 * @param candidate_region - Proposed failover target, if any.
 * @returns Frozen action describing behavior and permitted target region.
 */
export function plan_region_failure(
  mode: RegionFailureMode,
  policy: ResidencyPolicy,
  candidate_region?: string,
): FailureAction {
  const normalized_mode = one_of(mode, FAILURE_MODES, "region-failure-mode-invalid");
  const normalized_policy = validate_residency_policy(policy);
  const behavior = REGIONAL_FAILURE_MATRIX[normalized_mode];
  return Object.freeze({
    mode: normalized_mode,
    behavior,
    target_region: resolve_target(behavior, normalized_policy, candidate_region),
  });
}

/** Reject any region outside the tenant's residency boundary. */
export function assert_region_permitted(policy: ResidencyPolicy, region: string): void {
  const normalized = validate_residency_policy(policy);
  if (!normalized.allowed_regions.includes(region_name_value(region))) {
    throw new RegionalOperationsError("residency-region-not-permitted");
  }
}

function resolve_target(
  behavior: FailureBehavior,
  policy: ResidencyPolicy,
  candidate_region?: string,
): string | null {
  if (behavior !== "failover_to_approved_region") return null;
  if (candidate_region === undefined) throw new RegionalOperationsError("region-failover-target-required");
  const target = region_name_value(candidate_region);
  if (!policy.allowed_regions.includes(target)) throw new RegionalOperationsError("residency-failover-forbidden");
  return target;
}

function implied_rpo_minutes(config: ReplicationConfig): number {
  return config.max_replication_lag_seconds / SECONDS_PER_MINUTE;
}

function is_multi_region(strategy: DatabaseReplicationStrategy): boolean {
  return strategy === "synchronous_multi_primary" || strategy === "asynchronous_standby";
}

function one_of<T extends string>(value: unknown, allowed: readonly T[], reason: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new RegionalOperationsError(reason);
  }
  return value as T;
}

function bounded_integer(value: unknown, minimum: number, maximum: number, reason: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RegionalOperationsError(reason);
  }
  return value;
}

function region_name_value(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 64 ||
    !/^[a-z]{2}-[a-z]+-[0-9]{1,2}$/.test(value)
  ) {
    throw new RegionalOperationsError("region-name-invalid");
  }
  return value;
}

function tenant_id_value(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) {
    throw new RegionalOperationsError("residency-tenant-invalid");
  }
  return value;
}

const QUEUE_STRATEGIES: readonly QueueReplicationStrategy[] = Object.freeze([
  "at_least_once_single_region",
  "active_active_multi_region",
]);

const DATABASE_STRATEGIES: readonly DatabaseReplicationStrategy[] = Object.freeze([
  "synchronous_multi_primary",
  "asynchronous_standby",
  "single_primary_no_replica",
]);

const FAILURE_MODES: readonly RegionFailureMode[] = Object.freeze([
  "database_unavailable",
  "queue_unavailable",
  "provider_unreachable",
  "region_evicted",
]);