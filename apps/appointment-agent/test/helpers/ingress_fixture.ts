import type { IngressTriple } from "../../src/ingress/reconciliation.js";

/**
 * Build one tenant-scoped reconciliation triple for tests.
 *
 * Defaults describe an in-flight claim: an unprocessed retained row with a
 * pending worker job. Uses fixed past timestamps, never message content.
 */
export function ingress_triple(overrides: Partial<IngressTriple> = {}): IngressTriple {
  return {
    tenant_id: "42",
    wamid: "wamid-reconcile-1",
    has_claim: true,
    has_inbound_row: true,
    job_status: "pending",
    inbound_processed: false,
    observed_at: "2026-09-24T08:00:00.000Z",
    ...overrides,
  };
}
