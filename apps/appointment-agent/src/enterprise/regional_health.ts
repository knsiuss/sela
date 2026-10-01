/** Regional health-check contracts with a fail-closed completeness rule. */

/**
 * Bounded health check kinds.
 *
 * The set is closed so health labels stay low-cardinality in metrics and an
 * unrecognised probe cannot invent a new alerting dimension at runtime.
 */
export type HealthCheckKind = "database" | "queue_depth" | "provider_reachable" | "clock_skew";

/** Every kind a region must report before health can be claimed. */
export const REQUIRED_HEALTH_CHECKS: readonly HealthCheckKind[] = Object.freeze([
  "database",
  "queue_depth",
  "provider_reachable",
  "clock_skew",
]);

/** One component health observation; detail must stay a safe slug. */
export interface HealthCheckInput {
  kind: HealthCheckKind;
  is_healthy: boolean;
  detail_code: string;
}

/** One normalized health observation. */
export interface HealthCheckResult extends HealthCheckInput {
  is_required: boolean;
}

/** Aggregated health for a single region. */
export interface RegionHealthReport {
  region: string;
  checks: readonly HealthCheckResult[];
  state: "healthy" | "degraded" | "unhealthy";
  failing_kinds: readonly HealthCheckKind[];
}

/** Safe failure for an uninterpretable health contract. */
export class RegionalHealthError extends Error {
  readonly code = "regional_health_invalid";

  /** Create a sanitized regional-health failure. */
  constructor(reason: string) {
    super(reason);
    this.name = "RegionalHealthError";
  }
}

const HEALTH_KINDS: readonly HealthCheckKind[] = Object.freeze([
  "database",
  "queue_depth",
  "provider_reachable",
  "clock_skew",
]);

/**
 * Aggregate regional health, failing closed on an incomplete probe set.
 *
 * A region missing any required check is reported unhealthy rather than
 * healthy-by-default, so a partial probe can never authorize traffic.
 *
 * @param region - Region identifier the probes were collected from.
 * @param inputs - Observations to aggregate.
 * @returns Frozen report with state and the failing check kinds.
 */
export function evaluate_region_health(region: string, inputs: readonly HealthCheckInput[]): RegionHealthReport {
  const checks = normalize_checks(inputs);
  const failing = checks.filter((check) => !check.is_healthy).map((check) => check.kind);
  return Object.freeze({
    region: region_name_value(region),
    checks,
    state: state_for(checks, failing),
    failing_kinds: Object.freeze(failing),
  });
}

/** Reject duplicate or unknown probe kinds instead of double counting them. */
function normalize_checks(inputs: readonly HealthCheckInput[]): readonly HealthCheckResult[] {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new RegionalHealthError("health-inputs-invalid");
  const seen = new Set<HealthCheckKind>();
  const checks: HealthCheckResult[] = [];
  for (const input of inputs) {
    if (typeof input !== "object" || input === null) throw new RegionalHealthError("health-input-invalid");
    const kind = one_of(input.kind, HEALTH_KINDS, "health-kind-invalid");
    if (seen.has(kind)) throw new RegionalHealthError("health-kind-duplicated");
    seen.add(kind);
    checks.push(Object.freeze({
      kind,
      is_healthy: input.is_healthy === true,
      detail_code: safe_slug(input.detail_code),
      is_required: REQUIRED_HEALTH_CHECKS.includes(kind),
    }));
  }
  return Object.freeze(checks);
}

function state_for(
  checks: readonly HealthCheckResult[],
  failing: readonly HealthCheckKind[],
): "healthy" | "degraded" | "unhealthy" {
  const missing = REQUIRED_HEALTH_CHECKS.filter((kind) => !checks.some((check) => check.kind === kind));
  if (missing.length > 0) return "unhealthy";
  if (failing.length === 0) return "healthy";
  return failing.includes("database") ? "unhealthy" : "degraded";
}

function one_of<T extends string>(value: unknown, allowed: readonly T[], reason: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new RegionalHealthError(reason);
  }
  return value as T;
}

function safe_slug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,64}$/.test(value)) {
    throw new RegionalHealthError("health-detail-invalid");
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
    throw new RegionalHealthError("region-name-invalid");
  }
  return value;
}