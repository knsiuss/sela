/** Bounded alert evaluation hook for deployment-side Prometheus/SRE wiring. */

import { evaluate_alerts, type AlertEvaluation, type SloSnapshot } from "./slo.js";

/** Snapshot source owned by the deployment collector. */
export type SloSnapshotProvider = () => Promise<SloSnapshot>;

/** Alert delivery callback; implementations must not receive secrets or PII. */
export type AlertSink = (alerts: readonly AlertEvaluation[]) => Promise<void>;

/** Evaluate a snapshot and deliver only currently firing alerts. */
export async function evaluate_and_emit_alerts(
  provider: SloSnapshotProvider,
  sink: AlertSink,
): Promise<AlertEvaluation[]> {
  const snapshot = await provider();
  const firing = evaluate_alerts(snapshot).filter((alert) => alert.is_firing);
  await sink(firing);
  return firing;
}
