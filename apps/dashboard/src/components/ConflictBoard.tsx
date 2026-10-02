"use client";

/**
 * Conflict resolution state UI over the real conflict state machine.
 *
 * The board reads live conflicts from the workspace snapshot rather than from
 * props, so a decision taken here is reflected everywhere without a reload.
 * Accessibility contract: each conflict is a labelled group, every action is a
 * real `<button>`, every disabled control carries a visible associated reason,
 * and focus moves to the status region after each transition so a keyboard or
 * screen-reader user learns the outcome without hunting for it.
 */

import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import {
  allowed_conflict_actions,
  conflict_status_label,
  type ConflictActionKey,
  type ConflictRecord,
} from "@/domain/conflict_board";
import { format_datetime } from "./format_datetime";
import { StatusBadge } from "./StatusBadge";
import { status_tone } from "./status_tone";
import { use_workspace } from "./WorkspaceProvider";

/** Props for {@link ConflictBoard}. */
export interface ConflictBoardProps {
  tenant_id: string;
}

const ACTION_LABELS: Readonly<Record<ConflictActionKey, string>> = {
  propose: "Propose resolution", accept: "Accept resolution", reject: "Reject",
};

const ALL_ACTIONS: readonly ConflictActionKey[] = ["propose", "accept", "reject"];

/**
 * Render the conflict resolution board.
 *
 * @param props - The tenant this workspace is scoped to.
 * @returns The conflict list region.
 */
export function ConflictBoard(props: ConflictBoardProps): ReactElement {
  const workspace = use_workspace();
  const status_ref = useRef<HTMLParagraphElement>(null);
  const conflicts = workspace.snapshot.conflicts;
  const open_count = conflicts.filter(is_open).length;

  useEffect(() => {
    if (workspace.announcement_seq > 0) status_ref.current?.focus();
  }, [workspace.announcement_seq]);

  return (
    <section className="panel" aria-labelledby="conflicts-heading">
      <h2 id="conflicts-heading">Conflict resolution</h2>
      <p className="result-count" role="status" tabIndex={-1} ref={status_ref}>
        {open_count} of {conflicts.length} conflicts await a decision.
      </p>
      {conflicts.length === 0
        ? <p className="empty-state">No conflicts are recorded for this tenant.</p>
        : (
          <ul className="card-list">
            {conflicts.map((record) => <ConflictCard key={record.conflict_id} record={record} tenant_id={props.tenant_id} />)}
          </ul>
        )}
    </section>
  );
}

interface ConflictCardProps {
  record: ConflictRecord;
  tenant_id: string;
}

function ConflictCard(props: ConflictCardProps): ReactElement {
  const workspace = use_workspace();
  const heading_id = useId();
  const actions = allowed_conflict_actions(props.record, workspace.principal, props.tenant_id);
  const [slot, set_slot] = useState(default_slot(props.record));

  function run(action: ConflictActionKey): void {
    workspace.run_conflict_action(props.record.conflict_id, action, {
      proposed_slot_iso: action === "propose" ? new Date(slot).toISOString() : undefined,
      generation: props.record.generation,
    });
  }

  return (
    <li className="card" data-card-status={props.record.status}>
      <div role="group" aria-labelledby={heading_id} className="card__group">
        <h3 id={heading_id}>{props.record.conflict_id}</h3>
        <ConflictFacts record={props.record} />
        {actions.includes("propose") && (
          <SlotField heading_id={heading_id} slot={slot} reason_id={`${heading_id}-reason`} on_change={set_slot} />
        )}
        <ConflictActions
          record={props.record}
          actions={actions}
          reason_id={`${heading_id}-reason`}
          on_activate={run}
        />
        <p id={`${heading_id}-reason`} className="field__hint">{disabled_reason(props.record, actions)}</p>
      </div>
    </li>
  );
}

interface ConflictFactsProps {
  record: ConflictRecord;
}

function ConflictFacts(props: ConflictFactsProps): ReactElement {
  const record = props.record;
  return (
    <dl className="card__facts">
      <div key="appointment"><dt>Appointment</dt><dd className="cell--identifier">{record.appointment_id}</dd></div>
      <div key="status">
        <dt>Status</dt>
        <dd>
          <StatusBadge
            label={conflict_status_label(record.status)}
            tone={status_tone(record.status)}
            status={record.status}
          />
        </dd>
      </div>
      <div key="generation"><dt>Generation</dt><dd>{record.generation}</dd></div>
      <div key="proposed_slot">
        <dt>Proposed slot</dt>
        <dd>{record.proposed_slot_iso === null ? "None yet" : format_datetime(record.proposed_slot_iso)}</dd>
      </div>
      <div key="expires_at">
        <dt>Expires at</dt>
        <dd><time dateTime={record.expires_at_iso}>{format_datetime(record.expires_at_iso)}</time></dd>
      </div>
    </dl>
  );
}

interface SlotFieldProps {
  heading_id: string;
  slot: string;
  reason_id: string;
  on_change: (value: string) => void;
}

function SlotField(props: SlotFieldProps): ReactElement {
  const slot_id = `${props.heading_id}-slot`;
  return (
    <div className="field">
      <label htmlFor={slot_id}>Candidate resolution slot</label>
      <input
        id={slot_id}
        type="datetime-local"
        value={props.slot}
        onChange={(event) => props.on_change(event.target.value)}
        aria-describedby={props.reason_id}
      />
    </div>
  );
}

interface ConflictActionsProps {
  record: ConflictRecord;
  actions: readonly ConflictActionKey[];
  reason_id: string;
  on_activate: (action: ConflictActionKey) => void;
}

function ConflictActions(props: ConflictActionsProps): ReactElement {
  return (
    <div className="card__actions">
      {ALL_ACTIONS.map((action) => (
        <ActionButton
          key={action}
          action={action}
          conflict_id={props.record.conflict_id}
          enabled={props.actions.includes(action)}
          reason_id={props.reason_id}
          on_activate={() => props.on_activate(action)}
        />
      ))}
    </div>
  );
}

interface ActionButtonProps {
  action: ConflictActionKey;
  conflict_id: string;
  enabled: boolean;
  reason_id: string;
  on_activate: () => void;
}

function ActionButton(props: ActionButtonProps): ReactElement {
  return (
    <button
      type="button"
      disabled={!props.enabled}
      aria-describedby={props.enabled ? undefined : props.reason_id}
      onClick={props.on_activate}
      data-action={props.action}
      data-conflict={props.conflict_id}
    >
      {ACTION_LABELS[props.action]}
    </button>
  );
}

function is_open(record: ConflictRecord): boolean {
  return record.status === "pending" || record.status === "proposed";
}

function disabled_reason(record: ConflictRecord, actions: readonly ConflictActionKey[]): string {
  if (actions.length > 0) return `Available actions: ${actions.map((action) => ACTION_LABELS[action]).join(", ")}.`;
  if (!is_open(record)) {
    return `No actions available. This conflict is ${conflict_status_label(record.status).toLowerCase()}, which is terminal.`;
  }
  return "No actions available. The current role cannot reschedule appointments for this tenant.";
}

/**
 * Seed the slot input from the record.
 *
 * The input keeps the machine `datetime-local` value; only the read-only
 * summaries elsewhere are formatted for a human.
 */
function default_slot(record: ConflictRecord): string {
  const base = record.proposed_slot_iso ?? record.expires_at_iso;
  return base.slice(0, 16);
}