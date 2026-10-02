/**
 * Assignment, escalation, and SLA presentation over the real operator queue.
 *
 * Transitions are delegated to `operator_queue.ts`. The escalation cap and the
 * SLA breach rule are read from that module rather than restated here, so the
 * dashboard cannot drift from the backend contract.
 */

import { AuthorizationError, type AuthenticatedPrincipal } from "appointment-agent/dist/src/enterprise/authorization.js";
import { authorize } from "appointment-agent/dist/src/enterprise/authorization.js";
import {
  assign_item,
  escalate_item,
  is_sla_breached,
  MAX_ESCALATION_LEVEL,
  OperatorQueueError,
  resolve_item,
  type QueueItem,
  type QueueItemStatus,
} from "appointment-agent/dist/src/enterprise/operator_queue.js";

export type { QueueItem, QueueItemStatus };
export { MAX_ESCALATION_LEVEL };

/** Workflow transitions an operator may trigger. */
export type QueueActionKey = "assign" | "escalate" | "resolve";

/** Minutes before the SLA deadline at which an open item is flagged as due soon. */
export const SLA_DUE_SOON_MINUTES = 15;

/** Bounded escalation reasons accepted by the domain's `reason_code` rule. */
export const ESCALATION_REASON_CODES = ["sla_risk", "customer_replied", "calendar_blocked", "policy_review"] as const;

/** One bounded escalation reason selectable in the UI. */
export type EscalationReasonCode = (typeof ESCALATION_REASON_CODES)[number];

/** Human labels for the queue lifecycle. */
const STATUS_LABELS: Readonly<Record<QueueItemStatus, string>> = {
  unassigned: "Unassigned", assigned: "Assigned", escalated: "Escalated", resolved: "Resolved",
};

/** SLA urgency derived from the domain deadline. */
export type SlaState = "on_track" | "due_soon" | "breached" | "met";

/** Human labels for SLA urgency; never conveyed by colour alone. */
const SLA_LABELS: Readonly<Record<SlaState, string>> = {
  on_track: "On track", due_soon: "Due soon", breached: "Breached", met: "Met",
};

/** Result of one attempted queue transition. */
export type QueueOutcome =
  | { ok: true; item: QueueItem }
  | { ok: false; code: string };

/** One row of the queue board, with its SLA urgency resolved for display. */
export interface QueueRow {
  item: QueueItem;
  sla: SlaView;
  actions: readonly QueueActionKey[];
  escalation_slots_remaining: number;
}

/** SLA state and remaining time for one item. */
export interface SlaView {
  state: SlaState;
  due_at_iso: string;
  minutes_remaining: number;
}

/** Options for a queue transition. */
export interface QueueActionOptions {
  assignee_subject?: string;
  reason_code?: string;
}

/**
 * Return the transitions the domain would accept for this queue item.
 *
 * @param item - Current queue item.
 * @param principal - Acting synthetic principal.
 * @param tenant_id - Tenant the operator is scoped to.
 * @returns Allowed action keys in display order.
 */
export function allowed_queue_actions(
  item: QueueItem,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
): readonly QueueActionKey[] {
  if (item.tenant_id !== tenant_id) return [];
  if (item.status === "resolved") return [];
  if (!can_read_handoff(principal, tenant_id)) return [];
  const actions: QueueActionKey[] = ["assign"];
  if (escalation_slots_remaining(item) > 0) actions.push("escalate");
  actions.push("resolve");
  return actions;
}

/**
 * Apply one transition through the real operator-queue contract.
 *
 * @param item - Current queue item.
 * @param action - Transition to attempt.
 * @param principal - Acting synthetic principal.
 * @param tenant_id - Tenant the operator is scoped to.
 * @param options - Assignee for assign, bounded reason code for escalate.
 * @returns Updated item or the domain error code.
 */
export function apply_queue_action(
  item: QueueItem,
  action: QueueActionKey,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  options: QueueActionOptions = {},
): QueueOutcome {
  if (item.tenant_id !== tenant_id) return { ok: false, code: "operator-queue-tenant-mismatch" };
  try {
    if (action === "assign") return { ok: true, item: assign_item(item, require_assignee(options), principal, tenant_id) };
    if (action === "escalate") {
      return { ok: true, item: escalate_item(item, principal, tenant_id, require_reason(options)) };
    }
    return { ok: true, item: resolve_item(item, principal, tenant_id) };
  } catch (error) {
    return { ok: false, code: transition_code(error) };
  }
}

/**
 * Resolve the SLA urgency of one item against a reference time.
 *
 * @param item - Current queue item.
 * @param now - Reference time.
 * @returns SLA state, deadline, and whole minutes remaining.
 */
export function sla_view(item: QueueItem, now: Date): SlaView {
  const due_ms = Date.parse(item.sla_due_at_iso);
  const minutes_remaining = Math.floor((due_ms - now.getTime()) / 60_000);
  if (item.status === "resolved") return { state: "met", due_at_iso: item.sla_due_at_iso, minutes_remaining: 0 };
  if (is_sla_breached(item, now)) return { state: "breached", due_at_iso: item.sla_due_at_iso, minutes_remaining };
  if (minutes_remaining <= SLA_DUE_SOON_MINUTES) return { state: "due_soon", due_at_iso: item.sla_due_at_iso, minutes_remaining };
  return { state: "on_track", due_at_iso: item.sla_due_at_iso, minutes_remaining };
}

/** Project queue items into board rows, scoped to one tenant. */
export function build_queue_rows(
  items: readonly QueueItem[],
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  now: Date,
): QueueRow[] {
  return items
    .filter((item) => item.tenant_id === tenant_id)
    .map((item) => ({
      item,
      sla: sla_view(item, now),
      actions: allowed_queue_actions(item, principal, tenant_id),
      escalation_slots_remaining: escalation_slots_remaining(item),
    }));
}

/** Number of escalation levels still available before the cap. */
export function escalation_slots_remaining(item: QueueItem): number {
  return Math.max(0, MAX_ESCALATION_LEVEL - item.escalation_level);
}

/** Count open items whose SLA deadline has already passed. */
export function count_breached_items(items: readonly QueueItem[], now: Date): number {
  return items.filter((item) => is_sla_breached(item, now)).length;
}

/** Human label for a queue status. */
export function queue_status_label(status: QueueItemStatus): string {
  return STATUS_LABELS[status];
}

/** Human label for an SLA state. */
export function sla_state_label(state: SlaState): string {
  return SLA_LABELS[state];
}

function require_assignee(options: QueueActionOptions): string {
  if (options.assignee_subject === undefined || options.assignee_subject.trim() === "") {
    throw new OperatorQueueError("operator-queue-assignee-required");
  }
  return options.assignee_subject;
}

function require_reason(options: QueueActionOptions): string {
  if (options.reason_code === undefined) throw new OperatorQueueError("operator-queue-reason-required");
  return options.reason_code;
}

function can_read_handoff(principal: AuthenticatedPrincipal, tenant_id: string): boolean {
  try {
    authorize(principal, tenant_id, "handoff:read");
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
  if (error instanceof OperatorQueueError) return error.code;
  if (error instanceof AuthorizationError) return error.message;
  return "operator-queue-transition-failed";
}