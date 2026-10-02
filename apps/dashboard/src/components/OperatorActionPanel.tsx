"use client";

/**
 * Operator action surface mirroring `POST /v1/operator/actions`.
 *
 * Capability hints come from the real service preflight rather than a UI copy of
 * the role matrix, so this view can never offer an action the backend would
 * refuse. Reasons are bounded codes, never free text. Every attempt is appended
 * to the local audit store and projected into the redacted timeline.
 */

import { useId, useMemo, useState, type ReactElement, type RefObject } from "react";
import {
  OPERATOR_ACTIONS,
  OPERATOR_ACTION_REASON_CODES,
  outcome_label,
  type OperatorAction,
  type OperatorActionOutcome,
  type OperatorActionReasonCode,
} from "@/domain/operator_action_gateway";
import { is_operator_action, use_workspace } from "./WorkspaceProvider";
import {
  preflight_code,
  use_action_submission,
  use_operator_action_service,
  type ActionSelection,
} from "./use_operator_action";

/** Props for {@link OperatorActionPanel}. */
export interface OperatorActionPanelProps {
  tenant_id: string;
}

const ACTION_DESCRIPTIONS: Readonly<Record<OperatorAction, string>> = {
  resolve_conflict: "Record the operator decision that resolves a scheduling conflict.",
  reconcile_orphan: "Reconcile an orphaned outbound delivery against the durable ledger.",
  release_hold: "Release a stale slot hold so the slot can be offered again.",
  replay_outbound: "Replay an outbound message. Requires MFA and outbound replay rights.",
  export_audit: "Export the audit trail for this tenant. Read-only.",
};

const REASON_FIELD_ID = "operator-action-reason";

const BLOCKED_HINT_ID = "operator-action-blocked";

/**
 * Render the audited operator action surface.
 *
 * @param props - The tenant this workspace is scoped to.
 * @returns The action form region.
 */
export function OperatorActionPanel(props: OperatorActionPanelProps): ReactElement {
  const workspace = use_workspace();
  const [selection, set_selection] = useState<ActionSelection>({
    action: OPERATOR_ACTIONS[0], target: "", reason: OPERATOR_ACTION_REASON_CODES[0],
  });
  const { snapshot } = workspace;
  const { audit, service, targets } = use_operator_action_service(snapshot.conflicts, snapshot.queue_items);
  const blocked_code = useMemo(() => preflight_code(
    service, workspace.principal, props.tenant_id, selection, targets[0] ?? "unknown",
  ), [service, workspace.principal, props.tenant_id, selection, targets]);

  const submission = use_action_submission({
    selection,
    principal: workspace.principal,
    tenant_id: props.tenant_id,
    service,
    audit,
    record_entries: workspace.record_operator_action,
  });

  return (
    <section className="panel" aria-labelledby="actions-heading">
      <h2 id="actions-heading">Operator actions</h2>
      <p className="panel__note">
        Mirrors <code>POST /v1/operator/actions</code>. Server wiring is not connected yet, so attempts are
        authorized locally against the synthetic principal and appended to the local audit ledger.
      </p>
      <ActionSelectors
        selection={selection}
        targets={targets}
        on_change={set_selection}
      />
      <SubmitButton
        blocked_code={blocked_code}
        is_pending={submission.is_pending}
        hint_id={BLOCKED_HINT_ID}
        on_submit={() => void submission.submit()}
      />
      <ActionResult
        action={selection.action}
        blocked_code={blocked_code}
        outcome={submission.outcome}
        is_pending={submission.is_pending}
        status_ref={submission.status_ref}
      />
    </section>
  );
}

interface ActionSelectorsProps {
  selection: ActionSelection;
  targets: readonly string[];
  on_change: (selection: ActionSelection) => void;
}

function ActionSelectors(props: ActionSelectorsProps): ReactElement {
  const action_id = useId();
  const target_id = useId();
  return (
    <div className="filters">
      <div className="field">
        <label htmlFor={action_id}>Action</label>
        <select
          id={action_id}
          value={props.selection.action}
          onChange={(event) => {
            if (is_operator_action(event.target.value)) props.on_change({ ...props.selection, action: event.target.value });
          }}
        >
          {OPERATOR_ACTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={target_id}>Target</label>
        <select
          id={target_id}
          value={props.selection.target}
          onChange={(event) => props.on_change({ ...props.selection, target: event.target.value })}
        >
          <option value="">Select a target</option>
          {props.targets.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={REASON_FIELD_ID}>Reason code</label>
        <select
          id={REASON_FIELD_ID}
          value={props.selection.reason}
          onChange={(event) => props.on_change({ ...props.selection, reason: event.target.value as OperatorActionReasonCode })}
        >
          {OPERATOR_ACTION_REASON_CODES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
    </div>
  );
}

interface SubmitButtonProps {
  blocked_code: string | null;
  is_pending: boolean;
  hint_id: string;
  on_submit: () => void;
}

function SubmitButton(props: SubmitButtonProps): ReactElement {
  return (
    <button
      type="button"
      className="button--primary"
      onClick={props.on_submit}
      disabled={props.blocked_code !== null || props.is_pending}
      aria-describedby={props.blocked_code === null ? undefined : props.hint_id}
      data-action="submit-operator-action"
    >
      {props.is_pending ? "Running action" : "Run action"}
    </button>
  );
}

interface ActionResultProps {
  action: OperatorAction;
  blocked_code: string | null;
  outcome: OperatorActionOutcome | null;
  is_pending: boolean;
  status_ref: RefObject<HTMLParagraphElement | null>;
}

function ActionResult(props: ActionResultProps): ReactElement {
  return (
    <>
      <p id={BLOCKED_HINT_ID} className="field__hint">{props.blocked_code === null
        ? `Preflight passed for ${props.action}.`
        : `Preflight blocked: ${props.blocked_code}. The current local role cannot perform this action.`}</p>
      <p className="result-count" role="status" tabIndex={-1} ref={props.status_ref}>
        {status_text(props.action, props.outcome, props.is_pending)}
      </p>
      <p className="panel__note">{ACTION_DESCRIPTIONS[props.action]}</p>
    </>
  );
}

function status_text(action: OperatorAction, outcome: OperatorActionOutcome | null, is_pending: boolean): string {
  if (is_pending) return `Running ${action}.`;
  if (outcome === null) return "No action attempted in this session.";
  const code = outcome.code === null ? "" : ` with code ${outcome.code}`;
  return `${outcome.action} ${outcome_label(outcome.status)}${code}.`;
}