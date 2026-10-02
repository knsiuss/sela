"use client";

/**
 * React context binding for the local operator workspace.
 *
 * All state transitions live in `src/domain/*` and are bound to React state in
 * `use_workspace_transitions`; this file only owns the tree binding: it exposes
 * the snapshot, the transitions, and the polite announcement string that drives
 * each view's live region. Callers receive the domain's own `{ ok, code }`
 * results so they can move focus and announce failures instead of guessing.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { parse_authenticated_principal } from "appointment-agent/dist/src/enterprise/authorization.js";
import type { AuthenticatedPrincipal } from "appointment-agent/dist/src/enterprise/authorization.js";
import type { AuditEntry } from "@/domain/audit_timeline";
import type { OperatorAction } from "@/domain/operator_action_gateway";
import type { LocalPrincipalClaims } from "@/domain/synthetic_principal";
import type { WorkspaceSnapshot } from "@/domain/workspace_state";
import {
  use_workspace_transitions,
  type TransitionApi,
  type WorkspaceResult,
} from "./use_workspace_transitions";

export type { WorkspaceResult };

/** Everything the views may read or trigger. */
export interface WorkspaceContextValue extends TransitionApi {
  snapshot: WorkspaceSnapshot;
  principal: AuthenticatedPrincipal;
  /** Polite announcement rendered by each view's live region. */
  announcement: string;
  /** Monotonic counter so a repeated message still re-triggers announcements. */
  announcement_seq: number;
  /** Stable id list of rendered audit entries, used to announce only new rows. */
  audit_entry_ids: readonly string[];
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** Props the layout passes from the server into the client workspace. */
export interface WorkspaceProviderProps {
  snapshot: WorkspaceSnapshot;
  /** Plain claims; re-validated client-side through the real contract. */
  principal: LocalPrincipalClaims;
  children: ReactNode;
}

/**
 * Provide the local operator workspace to every view.
 *
 * @param props - Initial snapshot, synthetic claims, and rendered children.
 * @returns The provider element.
 */
export function WorkspaceProvider(props: WorkspaceProviderProps): ReactNode {
  const principal = useMemo(() => parse_authenticated_principal(props.principal), [props.principal]);
  const transitions = use_workspace_transitions(props.snapshot, principal);
  const audit_entry_ids = useMemo(
    () => transitions.snapshot.audit_entries.map((entry) => entry.entry_id),
    [transitions.snapshot.audit_entries],
  );

  const value = useMemo<WorkspaceContextValue>(() => ({
    snapshot: transitions.snapshot,
    principal,
    announcement: transitions.announcement.text,
    announcement_seq: transitions.announcement.seq,
    run_conflict_action: transitions.api.run_conflict_action,
    run_queue_action: transitions.api.run_queue_action,
    record_operator_action: transitions.api.record_operator_action,
    audit_entry_ids,
  }), [transitions, principal, audit_entry_ids]);

  return <WorkspaceContext.Provider value={value}>{props.children}</WorkspaceContext.Provider>;
}

/**
 * Read the operator workspace from context.
 *
 * @returns The context value.
 * @throws Error When no provider is mounted; failing loud beats silent no-ops.
 */
export function use_workspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error("workspace-provider-missing");
  return value;
}

/** Narrow a key to the audited action union for the action panel. */
export function is_operator_action(value: string): value is OperatorAction {
  return value === "resolve_conflict" || value === "reconcile_orphan" || value === "release_hold"
    || value === "replay_outbound" || value === "export_audit";
}