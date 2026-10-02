"use client";

/**
 * Assignment, escalation, and resolution workflow over the real queue contract.
 *
 * Escalation reasons are a bounded `<select>` of reason codes, never free text,
 * so the domain's `reason_code` rule can never be violated by an operator and no
 * customer content can enter the audit path.
 */

import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import {
  allowed_queue_actions,
  build_queue_rows,
  ESCALATION_REASON_CODES,
  MAX_ESCALATION_LEVEL,
  queue_status_label,
  type QueueActionKey,
  type QueueItemStatus,
} from "@/domain/operator_queue_board";
import { StatusBadge, type BadgeTone } from "./StatusBadge";
import { SlaTimer } from "./SlaTimer";
import { use_workspace } from "./WorkspaceProvider";

/** Props for {@link QueueBoard}. */
export interface QueueBoardProps {
  tenant_id: string;
}

/** One projected queue row, derived by the domain SLA contract. */
type QueueRow = ReturnType<typeof build_queue_rows>[number];

const ACTION_LABELS: Readonly<Record<QueueActionKey, string>> = {
  assign: "Assign", escalate: "Escalate", resolve: "Resolve",
};

const STATUS_TONES: Readonly<Record<QueueItemStatus, BadgeTone>> = {
  unassigned: "warning", assigned: "neutral", escalated: "critical", resolved: "positive",
};

const ALL_ACTIONS: readonly QueueActionKey[] = ["assign", "escalate", "resolve"];

/**
 * Render the operator queue board.
 *
 * @param props - The tenant this workspace is scoped to.
 * @returns The queue list region.
 */
export function QueueBoard(props: QueueBoardProps): ReactElement {
  const workspace = use_workspace();
  const status_ref = useRef<HTMLParagraphElement>(null);
  const now_ms = Date.parse(workspace.snapshot.now_iso);
  const rows = build_queue_rows(workspace.snapshot.queue_items, workspace.principal, props.tenant_id, new Date(now_ms));
  const breached = rows.filter((row) => row.sla.state === "breached").length;

  useEffect(() => {
    if (workspace.announcement_seq > 0) status_ref.current?.focus();
  }, [workspace.announcement_seq]);

  return (
    <section className="panel" aria-labelledby="queue-heading">
      <h2 id="queue-heading">Assignment and escalation</h2>
      <p className="result-count" role="status" tabIndex={-1} ref={status_ref}>
        {breached} of {rows.length} queue items are past their SLA deadline.
      </p>
      <ul className="card-list">
        {rows.map((row) => <QueueCard key={row.item.item_id} row={row} now_ms={now_ms} />)}
      </ul>
    </section>
  );
}

interface QueueCardProps {
  row: QueueRow;
  now_ms: number;
}

function QueueCard(props: QueueCardProps): ReactElement {
  const workspace = use_workspace();
  const heading_id = useId();
  const [assignee, set_assignee] = useState(props.row.item.assignee_subject ?? DEFAULT_ASSIGNEE);
  const [reason_code, set_reason_code] = useState<string>(ESCALATION_REASON_CODES[0]);
  const { item, actions } = props.row;

  function run(action: QueueActionKey): void {
    workspace.run_queue_action(item.item_id, action, {
      assignee_subject: action === "assign" ? assignee : undefined,
      reason_code: action === "escalate" ? reason_code : undefined,
    });
  }

  return (
    <li className="card">
      <div role="group" aria-labelledby={heading_id} className="card__group">
        <h3 id={heading_id}>{item.item_id}</h3>
        <QueueFacts row={props.row} now_ms={props.now_ms} />
        <QueueFields
          heading_id={heading_id}
          assignee={assignee}
          reason_code={reason_code}
          on_assignee={set_assignee}
          on_reason={set_reason_code}
        />
        <QueueActions item_id={item.item_id} actions={actions} reason_id={`${heading_id}-reason`} on_activate={run} />
        <p id={`${heading_id}-reason`} className="field__hint">{disabled_reason(props.row)}</p>
      </div>
    </li>
  );
}

interface QueueFactsProps {
  row: QueueRow;
  now_ms: number;
}

function QueueFacts(props: QueueFactsProps): ReactElement {
  const item = props.row.item;
  return (
    <dl className="card__facts">
      <div key="status">
        <dt>Status</dt>
        <dd><StatusBadge label={queue_status_label(item.status)} tone={STATUS_TONES[item.status]} status={item.status} /></dd>
      </div>
      <div key="assignee"><dt>Assignee</dt><dd>{item.assignee_subject ?? "Unassigned"}</dd></div>
      <div key="escalation">
        <dt>Escalation</dt>
        <dd>Level {item.escalation_level} of {MAX_ESCALATION_LEVEL}, {props.row.escalation_slots_remaining} remaining</dd>
      </div>
      <div key="sla"><dt>SLA</dt><dd><SlaTimer item={item} now_ms={props.now_ms} /></dd></div>
    </dl>
  );
}

interface QueueFieldsProps {
  heading_id: string;
  assignee: string;
  reason_code: string;
  on_assignee: (value: string) => void;
  on_reason: (value: string) => void;
}

function QueueFields(props: QueueFieldsProps): ReactElement {
  const assignee_id = `${props.heading_id}-assignee`;
  const escalate_id = `${props.heading_id}-escalate`;
  return (
    <>
      <div className="field">
        <label htmlFor={assignee_id}>Assign to operator subject</label>
        <select id={assignee_id} value={props.assignee} onChange={(event) => props.on_assignee(event.target.value)}>
          {ASSIGNABLE_SUBJECTS.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={escalate_id}>Escalation reason code</label>
        <select id={escalate_id} value={props.reason_code} onChange={(event) => props.on_reason(event.target.value)}>
          {ESCALATION_REASON_CODES.map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
      </div>
    </>
  );
}

interface QueueActionsProps {
  item_id: string;
  actions: readonly QueueActionKey[];
  reason_id: string;
  on_activate: (action: QueueActionKey) => void;
}

function QueueActions(props: QueueActionsProps): ReactElement {
  return (
    <div className="card__actions">
      {ALL_ACTIONS.map((action) => (
        <button
          key={action}
          type="button"
          disabled={!props.actions.includes(action)}
          aria-describedby={props.actions.includes(action) ? undefined : props.reason_id}
          data-action={action}
          data-item={props.item_id}
          onClick={() => props.on_activate(action)}
        >
          {ACTION_LABELS[action]}
        </button>
      ))}
    </div>
  );
}

const DEFAULT_ASSIGNEE = "local-operator";

const ASSIGNABLE_SUBJECTS: readonly string[] = ["local-operator", "local-supervisor"];

function disabled_reason(row: QueueRow): string {
  if (row.actions.length > 0) {
    return `Available actions: ${row.actions.map((action) => ACTION_LABELS[action]).join(", ")}.`;
  }
  if (row.item.status === "resolved") return "No actions available. This queue item is resolved, which is terminal.";
  return "No actions available. The current role cannot read the handoff queue for this tenant.";
}