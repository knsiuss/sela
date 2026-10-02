/**
 * Redacted, PII-minimized projection of the operator action audit ledger.
 *
 * The timeline is built by projecting a fixed set of already-redacted audit
 * fields. Free-text reasons are never read, never stored locally, and never
 * rendered, so customer content cannot reach this surface by construction.
 */

import type { OperatorAction } from "appointment-agent/dist/src/enterprise/operator_actions.js";
import type { StampedAuditRecord } from "./operator_action_gateway";

/** One row of the operator audit timeline. */
export interface AuditEntry {
  entry_id: string;
  tenant_id: string;
  actor_subject: string;
  action: OperatorAction;
  target_id: string;
  outcome: "succeeded" | "denied" | "failed";
  reason_code: string | null;
  request_id: string;
  at_iso: string;
}

/** Upper bound on rendered rows so the timeline cannot grow without limit. */
export const MAX_TIMELINE_ENTRIES = 50;

/** Fields the timeline is allowed to expose; anything else is dropped. */
const PROJECTED_FIELDS = [
  "entry_id", "tenant_id", "actor_subject", "action", "target_id",
  "outcome", "reason_code", "request_id", "at_iso",
] as const;

/** Failure raised when an audit row cannot be trusted. */
export class AuditTimelineError extends Error {
  readonly code: string;

  /** Create a sanitized audit-timeline failure. */
  constructor(code: string) {
    super(code);
    this.name = "AuditTimelineError";
    this.code = code;
  }
}

/** Human labels for an audited outcome. */
const OUTCOME_LABELS: Readonly<Record<AuditEntry["outcome"], string>> = {
  succeeded: "Succeeded", denied: "Denied", failed: "Failed",
};

/**
 * Project audit rows into a tenant-scoped, newest-first timeline.
 *
 * @param records - Append-only audit rows from the local audit store.
 * @param tenant_id - Tenant the operator is scoped to.
 * @returns At most {@link MAX_TIMELINE_ENTRIES} projected entries.
 */
export function build_audit_timeline(
  records: readonly StampedAuditRecord[],
  tenant_id: string,
): AuditEntry[] {
  if (typeof tenant_id !== "string" || !/^[1-9]\d{0,18}$/.test(tenant_id)) {
    throw new AuditTimelineError("audit-timeline-tenant-invalid");
  }
  return records
    .filter((record) => record.tenant_id === tenant_id)
    .map((record, index) => project(record, index))
    .sort(by_newest_first)
    .slice(0, MAX_TIMELINE_ENTRIES);
}

/**
 * Count entries newer than the ones already rendered.
 *
 * @param previous - Entry ids the view has already announced.
 * @param current - Entry ids currently rendered.
 * @returns Number of ids in `current` that are absent from `previous`.
 */
export function count_new_entries(previous: readonly string[], current: readonly string[]): number {
  const seen = new Set(previous);
  return current.filter((entry_id) => !seen.has(entry_id)).length;
}

/** Human label for an audited outcome. */
export function audit_outcome_label(outcome: AuditEntry["outcome"]): string {
  return OUTCOME_LABELS[outcome];
}

function project(record: StampedAuditRecord, index: number): AuditEntry {
  if (typeof record !== "object" || record === null) throw new AuditTimelineError("audit-timeline-record-invalid");
  if (!Number.isFinite(Date.parse(record.at_iso))) throw new AuditTimelineError("audit-timeline-timestamp-invalid");
  if (typeof record.request_id !== "string" || record.request_id === "" || record.request_id.length > 256) {
    throw new AuditTimelineError("audit-timeline-request-invalid");
  }
  const entry: AuditEntry = {
    entry_id: `${record.request_id}#${index}`,
    tenant_id: record.tenant_id,
    actor_subject: record.actor_subject,
    action: record.action,
    target_id: record.target_id,
    outcome: record.outcome,
    reason_code: record.reason_code ?? null,
    request_id: record.request_id,
    at_iso: record.at_iso,
  };
  // Projecting through the allow-list keeps a future audit field from reaching
  // the surface without an explicit review, and keeps `entry_id` in the output.
  return Object.fromEntries(PROJECTED_FIELDS.map((field) => [field, entry[field]])) as unknown as AuditEntry;
}

function by_newest_first(left: AuditEntry, right: AuditEntry): number {
  if (left.at_iso !== right.at_iso) return left.at_iso < right.at_iso ? 1 : -1;
  return right.entry_id.localeCompare(left.entry_id);
}