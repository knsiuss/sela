/** Per-tenant/per-location traffic model with bounded peak limits. */

/** Channels that generate ingress load against the webhook path. */
export type TrafficChannel = "whatsapp" | "sms" | "voice" | "web";

/** Validated daily traffic expectation for one tenant location. */
export interface TrafficEstimate {
  tenant_id: string;
  location_id: string;
  messages_per_day: number;
  appointments_per_day: number;
  peak_factor: number;
  channel: TrafficChannel;
}

/** Dependency-side ceiling applied before derived limits are accepted. */
export interface CapacityBounds {
  peak_webhook_rps: number;
  peak_worker_jobs_per_second: number;
  database_pool_max: number;
  provider_mps: number;
}

/** Bounded per-location peak rates safe to admit to dependencies. */
export interface PeakLimits {
  webhook_rps: number;
  worker_jobs_per_second: number;
  db_connections: number;
  provider_mps: number;
}

/** Safe failure when an estimate or derived limit is out of bounds. */
export class TrafficModelError extends Error {
  readonly code = "traffic_model_invalid";

  /** Create a sanitized traffic-model failure. */
  constructor() {
    super("traffic-model-invalid");
    this.name = "TrafficModelError";
  }
}

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_MINUTE = 60;
const CONTROL_CHARACTER_CEILING = 0x1f;
const DELETE_CHARACTER = 0x7f;
/**
 * Worst-case concurrent database handles per in-flight job: a reschedule job
 * can hold a calendar-write transaction and an outbound-ledger transaction at
 * the same time, so sizing the pool from job rate alone understates demand.
 */
const MAX_CONNECTIONS_PER_JOB = 2;

/**
 * Validate a traffic estimate and return a normalized immutable copy.
 *
 * @param value - Caller-supplied estimate candidate.
 * @returns Frozen estimate with every bound checked.
 */
export function validate_traffic_estimate(value: unknown): TrafficEstimate {
  if (typeof value !== "object" || value === null) throw new TrafficModelError();
  const record = value as Record<string, unknown>;
  const estimate: TrafficEstimate = {
    tenant_id: tenant_id(record.tenant_id),
    location_id: safe_identifier(record.location_id),
    messages_per_day: count(record.messages_per_day, 1, 10_000_000),
    appointments_per_day: count(record.appointments_per_day, 0, 10_000_000),
    peak_factor: factor(record.peak_factor),
    channel: channel(record.channel),
  };
  return Object.freeze(estimate);
}

/**
 * Derive bounded peak limits for one location, failing closed on overload.
 *
 * Raw rates scale the daily volume by the peak factor; any raw rate above the
 * matching dependency bound throws instead of silently clamping, so an
 * undersized deployment cannot claim capacity it does not have.
 *
 * @param estimate - Validated per-location traffic estimate.
 * @param bounds - Dependency-side ceilings for this deployment.
 * @returns Frozen peak limits within every bound.
 */
export function derive_peak_limits(estimate: TrafficEstimate, bounds: CapacityBounds): PeakLimits {
  const normalized = validate_traffic_estimate(estimate);
  const limits = compute_peak_limits(normalized);
  if (exceeds_bounds(limits, validate_bounds(bounds))) throw new TrafficModelError();
  return Object.freeze(limits);
}

function compute_peak_limits(estimate: TrafficEstimate): PeakLimits {
  const peak_messages = estimate.messages_per_day * estimate.peak_factor;
  const webhook_rps = Math.max(1, Math.ceil(peak_messages / SECONDS_PER_DAY));
  const provider_mps = Math.max(1, Math.ceil(peak_messages / SECONDS_PER_MINUTE));
  const worker_jobs_per_second = Math.max(
    1,
    Math.ceil(((estimate.messages_per_day + estimate.appointments_per_day) * estimate.peak_factor) / SECONDS_PER_DAY),
  );
  return {
    webhook_rps,
    worker_jobs_per_second,
    db_connections: Math.max(1, Math.ceil(worker_jobs_per_second * MAX_CONNECTIONS_PER_JOB)),
    provider_mps,
  };
}

function exceeds_bounds(limits: PeakLimits, bounds: CapacityBounds): boolean {
  return (
    limits.webhook_rps > bounds.peak_webhook_rps ||
    limits.worker_jobs_per_second > bounds.peak_worker_jobs_per_second ||
    limits.db_connections > bounds.database_pool_max ||
    limits.provider_mps > bounds.provider_mps
  );
}

function validate_bounds(value: unknown): CapacityBounds {
  if (typeof value !== "object" || value === null) throw new TrafficModelError();
  const record = value as Record<string, unknown>;
  return {
    peak_webhook_rps: count(record.peak_webhook_rps, 1, 1_000_000),
    peak_worker_jobs_per_second: count(record.peak_worker_jobs_per_second, 1, 1_000_000),
    database_pool_max: count(record.database_pool_max, 1, 1_000),
    provider_mps: count(record.provider_mps, 1, 1_000_000),
  };
}

function tenant_id(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new TrafficModelError();
  return value;
}

function safe_identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    has_control_character(value)
  ) {
    throw new TrafficModelError();
  }
  return value;
}

/**
 * Detect control characters by code point so no escape sequence in this file
 * can be reinterpreted as a literal byte and corrupt the source encoding.
 */
function has_control_character(value: string): boolean {
  for (const character of value) {
    const code_point = character.codePointAt(0) ?? 0;
    if (code_point <= CONTROL_CHARACTER_CEILING || code_point === DELETE_CHARACTER) return true;
  }
  return false;
}

function count(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TrafficModelError();
  }
  return value;
}

function factor(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 10) throw new TrafficModelError();
  return value;
}

function channel(value: unknown): TrafficChannel {
  if (value !== "whatsapp" && value !== "sms" && value !== "voice" && value !== "web") throw new TrafficModelError();
  return value;
}