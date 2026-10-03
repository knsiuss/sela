"use client";

/**
 * Wiring between the audited operator action service and the action panel.
 *
 * The audit store and the service are created once per mounted panel so the
 * ledger survives re-renders, and the submission hook owns the in-flight guard
 * that prevents a double submission of the same audited request.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AuthenticatedPrincipal } from "appointment-agent/dist/src/enterprise/authorization.js";
import { build_audit_timeline } from "@/domain/audit_timeline";
import type { ConflictRecord } from "@/domain/conflict_board";
import {
  build_operator_action_request,
  can_run_operator_action,
  create_local_action_service,
  create_stamping_audit_store,
  run_operator_action,
  type OperatorAction,
  type OperatorActionOutcome,
  type OperatorActionReasonCode,
  type StampingAuditStore,
} from "@/domain/operator_action_gateway";
import { authorize_operator_receipt, type ReceiptResult } from "@/app/operator_actions";
import type { OperatorActionService } from "appointment-agent/dist/src/enterprise/operator_actions.js";
import type { QueueItem } from "@/domain/operator_queue_board";

/** Authorizes one action tuple and returns the server's decision. */
export type ActionAuthorizer = (request: OperatorActionAuthorization) => Promise<ReceiptResult>;

/** The exact request tuple the server authorizes. */
export interface OperatorActionAuthorization {
  tenant_id: string;
  action: string;
  target_id: string;
  reason: string;
}

/** The action, target, and bounded reason an operator selected. */
export interface ActionSelection {
  action: OperatorAction;
  target: string;
  reason: OperatorActionReasonCode;
}

/** Local action service, its audit store, and the selectable target ids. */
export interface ActionService {
  audit: StampingAuditStore;
  service: OperatorActionService;
  targets: readonly string[];
}

/**
 * Create the local audited action service for the current workspace contents.
 *
 * @param conflicts - Conflict ids the workspace knows.
 * @param queue_items - Queue item ids the workspace knows.
 * @returns Service, audit store, and the combined target list.
 */
export function use_operator_action_service(
  conflicts: readonly ConflictRecord[],
  queue_items: readonly QueueItem[],
): ActionService {
  const targets = useMemo<LocalTargets>(() => ({
    conflict_ids: conflicts.map((record) => record.conflict_id),
    queue_item_ids: queue_items.map((item) => item.item_id),
  }), [conflicts, queue_items]);
  const audit = useMemo<StampingAuditStore>(() => create_stamping_audit_store(() => new Date()), []);
  const service = useMemo(() => create_local_action_service(audit, targets), [audit, targets]);
  const all_targets = useMemo(() => [...targets.conflict_ids, ...targets.queue_item_ids], [targets]);
  return { audit, service, targets: all_targets };
}

/** Submission state for one action attempt. */
export interface ActionSubmission {
  outcome: OperatorActionOutcome | null;
  is_pending: boolean;
  submit: () => Promise<void>;
  status_ref: RefObject<HTMLParagraphElement | null>;
}

/**
 * Run audited operator actions and focus the status region on completion.
 *
 * @param input - Selection, principal, tenant, service, audit sink, and authorizer.
 * @returns Outcome, pending flag, submit handler, and the status ref.
 */
export function use_action_submission(input: {
  selection: ActionSelection;
  principal: AuthenticatedPrincipal;
  tenant_id: string;
  service: OperatorActionService;
  audit: StampingAuditStore;
  record_entries: (outcome: OperatorActionOutcome, entries: ReturnType<typeof build_audit_timeline>) => void;
  /** Overridable so a DOM test can drive the panel without a server action. */
  authorize?: ActionAuthorizer;
}): ActionSubmission {
  const [outcome, set_outcome] = useState<OperatorActionOutcome | null>(null);
  const [is_pending, set_is_pending] = useState(false);
  const status_ref = useRef<HTMLParagraphElement>(null);
  const { selection, principal, tenant_id, service, audit, record_entries } = input;
  const authorize = input.authorize ?? authorize_operator_receipt;

  useEffect(() => {
    if (outcome !== null) status_ref.current?.focus();
  }, [outcome]);

  const submit = useCallback(async () => {
    if (selection.target === "") {
      set_outcome({ status: "failed", action: selection.action, target_id: "", code: "operator-action-target-required" });
      return;
    }
    if (is_pending) return;
    set_is_pending(true);
    // The server is the only authority on whether this action may run. Its
    // decision is taken against the session-derived principal, so a browser that
    // forges claims cannot widen its own scope; the local preflight below is a
    // usability hint that must agree with it.
    const authorized = await authorize({
      tenant_id: tenant_id,
      action: selection.action,
      target_id: selection.target,
      reason: selection.reason,
    });
    if (authorized.code !== null || authorized.receipt === null) {
      set_outcome({
        status: "denied",
        action: selection.action,
        target_id: selection.target,
        code: authorized.code ?? "forbidden",
      });
      record_entries(
        { status: "denied", action: selection.action, target_id: selection.target, code: authorized.code ?? "forbidden" },
        build_audit_timeline(audit.records, tenant_id),
      );
      set_is_pending(false);
      return;
    }
    const request = build_operator_action_request({
      principal, tenant_id, action: selection.action, target_id: selection.target, reason: selection.reason,
    });
    const result = await run_operator_action(service, request);
    record_entries(result, build_audit_timeline(audit.records, tenant_id));
    set_outcome(result);
    set_is_pending(false);
  }, [selection, principal, tenant_id, service, audit, record_entries, is_pending, authorize]);

  return { outcome, is_pending, submit, status_ref };
}

/**
 * Preflight a selection with the real service, without side effects.
 *
 * @param service - Configured operator action service.
 * @param principal - Acting synthetic principal.
 * @param tenant_id - Tenant the operator is scoped to.
 * @param selection - Selected action, target, and reason.
 * @param fallback_target - Target used while none has been chosen yet.
 * @returns Null when authorized, otherwise the domain authorization code.
 */
export function preflight_code(
  service: OperatorActionService,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  selection: ActionSelection,
  fallback_target: string,
): string | null {
  const target = selection.target === "" ? fallback_target : selection.target;
  const request = build_operator_action_request({
    principal,
    tenant_id,
    action: selection.action,
    target_id: target === "" ? "unknown" : target,
    reason: selection.reason,
  });
  return can_run_operator_action(service, request);
}

interface LocalTargets {
  conflict_ids: readonly string[];
  queue_item_ids: readonly string[];
}