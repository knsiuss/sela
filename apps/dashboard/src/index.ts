/**
 * Dashboard placeholder entrypoint.
 *
 * The staff dashboard (appointment list, approvals) lives here. Until the
 * UI lands, this module only exposes a health check so the app has a
 * verifiable build, typecheck, and test baseline.
 */

/** Health status reported by the dashboard app. */
export interface HealthStatus {
  ok: boolean;
  app: string;
}

/**
 * Report dashboard health.
 *
 * @returns A healthy status object.
 */
export function get_health(): HealthStatus {
  return { ok: true, app: "dashboard" };
}

console.log(JSON.stringify(get_health()));
