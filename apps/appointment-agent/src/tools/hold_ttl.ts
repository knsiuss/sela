import { MAX_HOLD_TTL_SECONDS } from "@repo/slot-engine";

/** App-level default hold lifetime; the shared package default remains 600 seconds. */
export const DEFAULT_HOLD_TTL_SECONDS = 300;

/**
 * Resolve the application hold TTL from environment configuration.
 *
 * The app deliberately defaults to five minutes. A configured value is
 * validated before it reaches the package and is capped at the package's
 * server-side maximum so the two layers cannot disagree about the lease.
 *
 * Args:
 *   env: Environment mapping; defaults to the process environment.
 *
 * Returns:
 *   A positive integer TTL no greater than `MAX_HOLD_TTL_SECONDS`.
 *
 * Raises:
 *   RangeError: If the configured value is not a positive integer.
 */
export function resolve_hold_ttl_seconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured_value = env["HOLD_TTL_SECONDS"];
  if (configured_value === undefined) return DEFAULT_HOLD_TTL_SECONDS;

  const parsed_value = Number(configured_value);
  if (!Number.isInteger(parsed_value) || parsed_value <= 0) {
    throw new RangeError("HOLD_TTL_SECONDS must be a positive integer");
  }
  return Math.min(parsed_value, MAX_HOLD_TTL_SECONDS);
}

/** Canonical app TTL resolved once during module initialization. */
export const HOLD_TTL_SECONDS = resolve_hold_ttl_seconds();

/**
 * Clamp a caller-provided TTL at the shared package maximum.
 *
 * Args:
 *   ttl_seconds: Requested positive integer lifetime.
 *
 * Returns:
 *   The requested lifetime capped at the package maximum.
 *
 * Raises:
 *   RangeError: If the requested value is not a positive integer.
 */
export function clamp_hold_ttl_seconds(ttl_seconds: number): number {
  if (!Number.isInteger(ttl_seconds) || ttl_seconds <= 0) {
    throw new RangeError("hold TTL must be a positive integer");
  }
  return Math.min(ttl_seconds, MAX_HOLD_TTL_SECONDS);
}
