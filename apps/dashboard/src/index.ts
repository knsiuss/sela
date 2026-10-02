/**
 * Shared health surface for the operator dashboard.
 *
 * The dashboard used to be an executable placeholder that logged this payload
 * on import. It is now consumed as a module by the overview page, so the
 * module-scope side effect was removed while the contract stayed identical.
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
