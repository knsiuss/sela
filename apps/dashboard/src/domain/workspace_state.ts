/**
 * Immutable client workspace snapshot shared by every operator view.
 *
 * One snapshot holds the tenant-scoped appointments, conflicts, queue items,
 * and audit entries so the views cannot disagree with each other. Updates are
 * pure: each helper returns a new snapshot and never mutates its input.
 */

import type { AuditEntry } from "./audit_timeline";
import type { CalendarAppointment } from "./appointments_view";
import type { ConflictRecord } from "./conflict_board";
import type { WorkspaceFixture } from "./fixtures";
import { scope_to_tenant } from "./appointments_view";
import type { QueueItem } from "./operator_queue_board";

/** Everything the operator views read from, scoped to exactly one tenant. */
export interface WorkspaceSnapshot {
  tenant_id: string;
  /** Reference time the snapshot was built against; keeps SLA rendering stable. */
  now_iso: string;
  appointments: readonly CalendarAppointment[];
  conflicts: readonly ConflictRecord[];
  queue_items: readonly QueueItem[];
  audit_entries: readonly AuditEntry[];
  /** Rows removed by tenant scoping, surfaced so the boundary stays observable. */
  hidden_by_tenant_scope: number;
}

/**
 * Build the starting snapshot from the synthetic fixture.
 *
 * @param fixture - Synthetic dataset for the local tenant.
 * @param tenant_id - Tenant this process is scoped to.
 * @param now_ms - Reference epoch milliseconds.
 * @returns Snapshot with foreign-tenant rows already removed.
 */
export function create_workspace_snapshot(
  fixture: WorkspaceFixture,
  tenant_id: string,
  now_ms: number,
): WorkspaceSnapshot {
  const all_appointments = [...fixture.appointments, ...fixture.foreign_appointments];
  const scoped = scope_to_tenant(all_appointments, tenant_id);
  return {
    tenant_id,
    now_iso: new Date(now_ms).toISOString(),
    appointments: scoped.map((appointment) => ({ ...appointment })),
    conflicts: fixture.conflicts.map((record) => ({ ...record })),
    queue_items: fixture.queue_items.map((item) => ({ ...item })),
    audit_entries: [],
    hidden_by_tenant_scope: all_appointments.length - scoped.length,
  };
}

/** Replace the conflicts, keeping every other slice untouched. */
export function with_conflicts(snapshot: WorkspaceSnapshot, conflicts: readonly ConflictRecord[]): WorkspaceSnapshot {
  return { ...snapshot, conflicts: [...conflicts] };
}

/** Replace the queue items, keeping every other slice untouched. */
export function with_queue_items(snapshot: WorkspaceSnapshot, queue_items: readonly QueueItem[]): WorkspaceSnapshot {
  return { ...snapshot, queue_items: [...queue_items] };
}

/** Replace the audit entries, keeping every other slice untouched. */
export function with_audit_entries(snapshot: WorkspaceSnapshot, audit_entries: readonly AuditEntry[]): WorkspaceSnapshot {
  return { ...snapshot, audit_entries: [...audit_entries] };
}

/** Return the snapshot with one conflict replaced, matched by conflict id. */
export function replace_conflict(snapshot: WorkspaceSnapshot, conflict: ConflictRecord): WorkspaceSnapshot {
  return with_conflicts(
    snapshot,
    snapshot.conflicts.map((candidate) => (candidate.conflict_id === conflict.conflict_id ? { ...conflict } : candidate)),
  );
}

/** Return the snapshot with one queue item replaced, matched by item id. */
export function replace_queue_item(snapshot: WorkspaceSnapshot, item: QueueItem): WorkspaceSnapshot {
  return with_queue_items(
    snapshot,
    snapshot.queue_items.map((candidate) => (candidate.item_id === item.item_id ? { ...item } : candidate)),
  );
}