/**
 * Presentation layer over the real conflict-resolution state machine.
 *
 * Every transition is delegated to `conflict_resolution.ts`; this module only
 * decides which transitions to *offer* (mirroring the domain preconditions so
 * the UI never shows a control the domain will reject), enforces tenant scope
 * before the call, and converts domain error codes into values instead of
 * exceptions so the view can announce them.
 */

import { AuthorizationError, type AuthenticatedPrincipal } from "appointment-agent/dist/src/enterprise/authorization.js";
import { authorize } from "appointment-agent/dist/src/enterprise/authorization.js";
import {
  accept_resolution,
  ConflictError,
  expire_conflict,
  propose_resolution,
  reject_resolution,
  type ConflictRecord,
  type ConflictStatus,
} from "appointment-agent/dist/src/enterprise/conflict_resolution.js";

export type { ConflictRecord, ConflictStatus };

/** Transitions an operator may trigger from the dashboard. */
export type ConflictActionKey = "propose" | "accept" | "reject";

/** Conflict statuses that still accept a decision. */
const OPEN_STATUSES: readonly ConflictStatus[] = ["pending", "proposed"];

/** Human labels for the conflict lifecycle. */
const STATUS_LABELS: Readonly<Record<ConflictStatus, string>> = {
  pending: "Pending", proposed: "Proposed", accepted: "Accepted", rejected: "Rejected", expired: "Expired",
};

/** Result of one attempted transition; failures carry the domain's own code. */
export type ConflictOutcome =
  | { ok: true; record: ConflictRecord }
  | { ok: false; code: string };

/** Options for a transition; `generation` guards accept, `slot` drives propose. */
export interface ConflictActionOptions {
  proposed_slot_iso?: string;
  generation?: number;
}

/**
 * Return the transitions the domain would accept for this record.
 *
 * @param record - Current conflict record.
 * @param principal - Acting synthetic principal.
 * @param tenant_id - Tenant the operator is scoped to.
 * @returns Allowed action keys in display order.
 */
export function allowed_conflict_actions(
  record: ConflictRecord,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
): readonly ConflictActionKey[] {
  if (record.tenant_id !== tenant_id) return [];
  if (!OPEN_STATUSES.includes(record.status)) return [];
  if (!can_reschedule(principal, tenant_id)) return [];
  const actions: ConflictActionKey[] = [];
  if (record.status === "pending") actions.push("propose");
  if (record.status === "proposed" && principal.has_mfa) actions.push("accept");
  if (record.status === "pending" || record.status === "proposed") actions.push("reject");
  return actions;
}

/**
 * Apply one transition through the real conflict contract.
 *
 * @param record - Current conflict record.
 * @param action - Transition to attempt.
 * @param principal - Acting synthetic principal.
 * @param tenant_id - Tenant the operator is scoped to.
 * @param options - Slot for propose, expected generation for accept.
 * @returns Updated record or the domain error code.
 */
export function apply_conflict_action(
  record: ConflictRecord,
  action: ConflictActionKey,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  options: ConflictActionOptions = {},
): ConflictOutcome {
  if (record.tenant_id !== tenant_id) return { ok: false, code: "conflict-tenant-mismatch" };
  try {
    if (action === "propose") return propose_outcome(record, principal, tenant_id, options);
    if (action === "accept") return accept_outcome(record, principal, tenant_id, options);
    return { ok: true, record: reject_resolution(record, principal, tenant_id) };
  } catch (error) {
    return { ok: false, code: transition_code(error) };
  }
}

/**
 * Expire every conflict whose deadline has passed, preserving order.
 *
 * @param records - Records to sweep.
 * @param now - Reference time.
 * @returns Records with expired ones replaced by the domain's expired form.
 */
export function expire_due_conflicts(
  records: readonly ConflictRecord[],
  now: Date,
): ConflictRecord[] {
  return records.map((record) => ({ ...expire_conflict(record, now) }));
}

/**
 * Count conflicts that are still awaiting an operator decision.
 *
 * @param records - Records to inspect.
 * @returns Number of open (pending or proposed) conflicts.
 */
export function count_open_conflicts(records: readonly ConflictRecord[]): number {
  return records.filter((record) => OPEN_STATUSES.includes(record.status)).length;
}

/** Human label for a conflict status. */
export function conflict_status_label(status: ConflictStatus): string {
  return STATUS_LABELS[status];
}

function propose_outcome(
  record: ConflictRecord,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  options: ConflictActionOptions,
): ConflictOutcome {
  if (options.proposed_slot_iso === undefined) return { ok: false, code: "conflict-slot-required" };
  const updated = propose_resolution(record, options.proposed_slot_iso, principal, tenant_id);
  return { ok: true, record: updated };
}

function accept_outcome(
  record: ConflictRecord,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  options: ConflictActionOptions,
): ConflictOutcome {
  const updated = accept_resolution(record, principal, tenant_id, options.generation ?? record.generation);
  return { ok: true, record: updated };
}

function can_reschedule(principal: AuthenticatedPrincipal, tenant_id: string): boolean {
  try {
    authorize(principal, tenant_id, "appointments:reschedule");
    return true;
  } catch {
    return false;
  }
}

/**
 * Map a domain failure onto a stable code.
 *
 * Authorization failures keep their own code so the operator is told the real
 * reason (`authorization-forbidden`) instead of a generic transition failure.
 */
function transition_code(error: unknown): string {
  if (error instanceof ConflictError) return error.code;
  if (error instanceof AuthorizationError) return error.message;
  return "conflict-transition-failed";
}