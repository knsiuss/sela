/** Operator assignment, escalation, and SLA timer backend contracts. */

import { authorize, type AuthenticatedPrincipal } from "./authorization.js";

/** Queue lifecycle; resolved is terminal. */
export type QueueItemStatus = "unassigned" | "assigned" | "escalated" | "resolved";

/** One tenant-scoped work item. */
export interface QueueItem {
  item_id: string;
  tenant_id: string;
  status: QueueItemStatus;
  assignee_subject: string | null;
  sla_due_at_iso: string;
  escalation_level: number;
  created_at_iso: string;
  updated_at_iso: string;
}

/** Input for enqueueing an item. */
export interface EnqueueItemInput {
  item_id: string;
  tenant_id: string;
  sla_minutes: number;
  clock?: () => Date;
}

/** Default SLA window in minutes. */
export const DEFAULT_OPERATOR_SLA_MINUTES = 60;

/** Highest escalation level before human on-call follow-up. */
export const MAX_ESCALATION_LEVEL = 3;

/** Failure with a stable machine-readable code. */
export class OperatorQueueError extends Error {
  readonly code: string;

  /** Create a sanitized queue failure. */
  constructor(code: string) {
    super(code);
    this.name = "OperatorQueueError";
    this.code = code;
  }
}

/**
 * Enqueue one item with an SLA deadline.
 *
 * @param input - Item id, tenant, and SLA window.
 * @returns New unassigned item.
 */
export function enqueue_item(input: EnqueueItemInput): QueueItem {
  if (typeof input !== "object" || input === null) throw new OperatorQueueError("operator-queue-invalid");
  const item_id = require_safe_id(input.item_id);
  require_tenant_id(input.tenant_id);
  if (!Number.isSafeInteger(input.sla_minutes) || input.sla_minutes < 1 || input.sla_minutes > 10_080) {
    throw new OperatorQueueError("operator-queue-sla-invalid");
  }
  const now_ms = (input.clock ?? (() => new Date()))().getTime();
  const now = new Date(now_ms).toISOString();
  return {
    item_id, tenant_id: input.tenant_id, status: "unassigned", assignee_subject: null,
    sla_due_at_iso: new Date(now_ms + input.sla_minutes * 60_000).toISOString(),
    escalation_level: 0, created_at_iso: now, updated_at_iso: now,
  };
}

/**
 * Assign an item to an operator.
 *
 * @param item - Current item.
 * @param assignee_subject - Operator receiving the item.
 * @param principal - Acting principal with handoff:read.
 * @param tenant_id - Owning tenant.
 * @returns Assigned item.
 */
export function assign_item(
  item: QueueItem,
  assignee_subject: string,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
): QueueItem {
  const current = require_item(item);
  authorize(principal, tenant_id, "handoff:read");
  require_scope(current, tenant_id);
  if (current.status === "resolved") throw new OperatorQueueError("operator-queue-assign-resolved");
  require_safe_id(assignee_subject);
  return { ...current, status: "assigned", assignee_subject, updated_at_iso: new Date().toISOString() };
}

/**
 * Escalate an item one level with a bounded reason code.
 *
 * @param item - Current item.
 * @param principal - Acting principal with handoff:read.
 * @param tenant_id - Owning tenant.
 * @param reason_code - Bounded escalation reason.
 * @returns Escalated item.
 */
export function escalate_item(
  item: QueueItem,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  reason_code: string,
): QueueItem {
  const current = require_item(item);
  authorize(principal, tenant_id, "handoff:read");
  require_scope(current, tenant_id);
  if (current.status === "resolved") throw new OperatorQueueError("operator-queue-escalate-resolved");
  if (!/^[a-z0-9_]{1,64}$/.test(reason_code)) throw new OperatorQueueError("operator-queue-reason-invalid");
  if (current.escalation_level >= MAX_ESCALATION_LEVEL) throw new OperatorQueueError("operator-queue-escalation-max");
  return {
    ...current, status: "escalated", escalation_level: current.escalation_level + 1,
    updated_at_iso: new Date().toISOString(),
  };
}

/**
 * Resolve an item; terminal.
 *
 * @param item - Current item.
 * @param principal - Acting principal with handoff:read.
 * @param tenant_id - Owning tenant.
 * @returns Resolved item.
 */
export function resolve_item(item: QueueItem, principal: AuthenticatedPrincipal, tenant_id: string): QueueItem {
  const current = require_item(item);
  authorize(principal, tenant_id, "handoff:read");
  require_scope(current, tenant_id);
  if (current.status === "resolved") throw new OperatorQueueError("operator-queue-already-resolved");
  return { ...current, status: "resolved", updated_at_iso: new Date().toISOString() };
}

/**
 * Return true when now is past the SLA deadline and the item is open.
 *
 * @param item - Item to inspect.
 * @param now - Reference time.
 * @returns True when breached.
 */
export function is_sla_breached(item: QueueItem, now: Date = new Date()): boolean {
  const current = require_item(item);
  if (current.status === "resolved") return false;
  return Date.parse(current.sla_due_at_iso) < now.getTime();
}

/** In-memory queue adapter for tests and explicit local mode. */
export class InMemoryOperatorQueue {
  private readonly rows = new Map<string, QueueItem>();

  /**
   * Persist an item.
   *
   * @param item - Item to store.
   */
  async save(item: QueueItem): Promise<void> {
    this.rows.set(require_item(item).item_id, { ...item });
  }

  /**
   * Read one item.
   *
   * @param item_id - Item identifier.
   * @returns A copy or null.
   */
  async get(item_id: string): Promise<QueueItem | null> {
    const found = this.rows.get(item_id);
    return found === undefined ? null : { ...found };
  }
}

function require_item(value: QueueItem): QueueItem {
  if (typeof value !== "object" || value === null) throw new OperatorQueueError("operator-queue-invalid");
  require_safe_id(value.item_id);
  require_tenant_id(value.tenant_id);
  if (!is_status(value.status)) throw new OperatorQueueError("operator-queue-status-invalid");
  if (!Number.isSafeInteger(value.escalation_level) || value.escalation_level < 0
    || value.escalation_level > MAX_ESCALATION_LEVEL) throw new OperatorQueueError("operator-queue-level-invalid");
  return value;
}

function is_status(value: unknown): value is QueueItemStatus {
  return value === "unassigned" || value === "assigned" || value === "escalated" || value === "resolved";
}

function require_scope(item: QueueItem, tenant_id: string): void {
  require_tenant_id(tenant_id);
  if (item.tenant_id !== tenant_id) throw new OperatorQueueError("operator-queue-tenant-mismatch");
}

function require_tenant_id(value: string): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new OperatorQueueError("operator-queue-tenant-invalid");
  return value;
}

function require_safe_id(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
    || value.trim() !== value || /[\u0000-]/u.test(value)) throw new OperatorQueueError("operator-queue-id-invalid");
  return value;
}
