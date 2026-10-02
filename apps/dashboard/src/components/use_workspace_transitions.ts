"use client";

/**
 * Workspace transitions bound to React state.
 *
 * Each hook owns one slice of the workflow and delegates the state transition
 * to the matching domain module, so the provider only has to assemble them.
 * Both hooks return the domain's own `{ ok, code }` result to the caller and
 * announce the outcome for the polite live region.
 */

import { useCallback, useMemo, useState } from "react";
import type { AuthenticatedPrincipal } from "appointment-agent/dist/src/enterprise/authorization.js";
import type { AuditEntry } from "@/domain/audit_timeline";
import { apply_conflict_action, type ConflictActionKey, type ConflictActionOptions, type ConflictRecord } from "@/domain/conflict_board";
import type { OperatorActionOutcome } from "@/domain/operator_action_gateway";
import { apply_queue_action, type QueueActionKey, type QueueActionOptions, type QueueItem } from "@/domain/operator_queue_board";
import type { WorkspaceSnapshot } from "@/domain/workspace_state";
import { replace_conflict, replace_queue_item, with_audit_entries } from "@/domain/workspace_state";

/** Result of a view-initiated transition, mirroring the domain result shape. */
export type WorkspaceResult = { ok: true; message: string } | { ok: false; message: string };

/** Announcement state that drives every view's live region. */
export interface Announcement {
  text: string;
  seq: number;
}

/** The announcement hooks hand back, so views can focus on a change. */
export interface TransitionApi {
  run_conflict_action: (conflict_id: string, action: ConflictActionKey, options?: ConflictActionOptions) => WorkspaceResult;
  run_queue_action: (item_id: string, action: QueueActionKey, options?: QueueActionOptions) => WorkspaceResult;
  record_operator_action: (outcome: OperatorActionOutcome, entries: readonly AuditEntry[]) => void;
}

/**
 * Own the workspace snapshot and its domain-backed transitions.
 *
 * @param initial_snapshot - Snapshot built on the server for this render.
 * @param principal - Synthetic principal validated from plain claims.
 * @returns Snapshot, transitions, and the announcement state.
 */
export function use_workspace_transitions(
  initial_snapshot: WorkspaceSnapshot,
  principal: AuthenticatedPrincipal,
): { snapshot: WorkspaceSnapshot; announcement: Announcement; api: TransitionApi } {
  const [snapshot, set_snapshot] = useState(initial_snapshot);
  const [announcement, set_announcement] = useState<Announcement>({ text: "", seq: 0 });
  const tenant_id = initial_snapshot.tenant_id;

  const announce = useCallback((text: string) => {
    set_announcement((previous) => ({ text, seq: previous.seq + 1 }));
  }, []);

  const run_conflict_action = useCallback<TransitionApi["run_conflict_action"]>(
    (conflict_id, action, options) => transition_conflict(
      snapshot.conflicts, conflict_id, action, options, principal, tenant_id,
      announce, (record) => set_snapshot((previous) => replace_conflict(previous, record)),
    ),
    [snapshot.conflicts, principal, tenant_id, announce],
  );

  const run_queue_action = useCallback<TransitionApi["run_queue_action"]>(
    (item_id, action, options) => transition_queue(
      snapshot.queue_items, item_id, action, options, principal, tenant_id,
      announce, (item) => set_snapshot((previous) => replace_queue_item(previous, item)),
    ),
    [snapshot.queue_items, principal, tenant_id, announce],
  );

  const record_operator_action = useCallback<TransitionApi["record_operator_action"]>((outcome, entries) => {
    set_snapshot((previous) => with_audit_entries(previous, entries));
    announce(outcome.status === "succeeded" ? `Operator action ${outcome.action} succeeded.` : `Operator action ${outcome.action} ${outcome.status}.`);
  }, [announce]);

  const api = useMemo<TransitionApi>(() => ({ run_conflict_action, run_queue_action, record_operator_action }),
    [run_conflict_action, run_queue_action, record_operator_action]);

  return { snapshot, announcement, api };
}

/** Everything a transition needs from React, passed explicitly to keep it testable. */
interface TransitionDeps<TRecord> {
  records: readonly TRecord[];
  principal: AuthenticatedPrincipal;
  tenant_id: string;
  announce: (text: string) => void;
  apply: (record: TRecord) => void;
}

function transition_conflict(
  records: TransitionDeps<ConflictRecord>["records"],
  conflict_id: string,
  action: ConflictActionKey,
  options: ConflictActionOptions | undefined,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  announce: (text: string) => void,
  apply: (record: ConflictRecord) => void,
): WorkspaceResult {
  const current = records.find((record) => record.conflict_id === conflict_id);
  if (current === undefined) return { ok: false, message: `Conflict ${conflict_id} is not in this workspace.` };
  const outcome = apply_conflict_action(current, action, principal, tenant_id, options ?? {});
  if (!outcome.ok) {
    announce(`Action denied. Reason code ${outcome.code}.`);
    return { ok: false, message: outcome.code };
  }
  apply(outcome.record);
  announce(`Conflict ${conflict_id} updated.`);
  return { ok: true, message: `Conflict ${conflict_id} updated.` };
}

function transition_queue(
  records: TransitionDeps<QueueItem>["records"],
  item_id: string,
  action: QueueActionKey,
  options: QueueActionOptions | undefined,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  announce: (text: string) => void,
  apply: (item: QueueItem) => void,
): WorkspaceResult {
  const current = records.find((record) => record.item_id === item_id);
  if (current === undefined) return { ok: false, message: `Queue item ${item_id} is not in this workspace.` };
  const outcome = apply_queue_action(current, action, principal, tenant_id, options ?? {});
  if (!outcome.ok) {
    announce(`Action denied. Reason code ${outcome.code}.`);
    return { ok: false, message: outcome.code };
  }
  apply(outcome.item);
  announce(`Queue item ${item_id} updated.`);
  return { ok: true, message: `Queue item ${item_id} updated.` };
}