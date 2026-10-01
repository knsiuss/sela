/** Capacity contract for tenant fairness, provider limits, and safe scale-out. */

/** Conservative default Cloud API throughput before account-specific verification. */
export const DEFAULT_PROVIDER_MPS = 80;

/** Validated capacity inputs for a deployment or load-test profile. */
export interface CapacityProfile {
  peak_webhook_rps: number;
  peak_worker_jobs_per_second: number;
  max_tenant_rps: number;
  database_pool_max: number;
  provider_mps: number;
  headroom_ratio: number;
}

/** Safe failure when a capacity profile could violate a dependency limit. */
export class CapacityConfigurationError extends Error {
  readonly code = "capacity_configuration_invalid";

  /** Create a sanitized capacity failure. */
  constructor() {
    super("capacity-configuration-invalid");
    this.name = "CapacityConfigurationError";
  }
}

/** Validate a profile and return a normalized immutable copy. */
export function validate_capacity_profile(value: unknown): CapacityProfile {
  if (typeof value !== "object" || value === null) throw new CapacityConfigurationError();
  const record = value as Record<string, unknown>;
  const profile: CapacityProfile = {
    peak_webhook_rps: positive_number(record.peak_webhook_rps),
    peak_worker_jobs_per_second: positive_number(record.peak_worker_jobs_per_second),
    max_tenant_rps: positive_number(record.max_tenant_rps),
    database_pool_max: positive_integer(record.database_pool_max, 1000),
    provider_mps: positive_number(record.provider_mps),
    headroom_ratio: positive_number(record.headroom_ratio),
  };
  if (profile.provider_mps > DEFAULT_PROVIDER_MPS) throw new CapacityConfigurationError();
  if (profile.headroom_ratio < 1 || profile.headroom_ratio > 10) throw new CapacityConfigurationError();
  if (profile.max_tenant_rps > profile.peak_webhook_rps * profile.headroom_ratio) {
    throw new CapacityConfigurationError();
  }
  return Object.freeze(profile);
}

/** Derive a bounded worker concurrency target from the database pool and queue rate. */
export function recommended_worker_concurrency(profile: CapacityProfile): number {
  const normalized = validate_capacity_profile(profile);
  return Math.max(1, Math.min(
    normalized.database_pool_max,
    Math.ceil(normalized.peak_worker_jobs_per_second * normalized.headroom_ratio),
  ));
}

function positive_number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new CapacityConfigurationError();
  }
  return value;
}

function positive_integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new CapacityConfigurationError();
  }
  return value;
}
