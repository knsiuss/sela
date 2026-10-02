"use client";

/**
 * Redacted operator audit timeline.
 *
 * Only the fields the domain audit store already persists are rendered: the
 * free-text `reason` a caller submits is deliberately absent from this surface,
 * so no customer content can appear here. New rows are announced politely
 * instead of on every re-render.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  audit_outcome_label,
  count_new_entries,
  type AuditEntry,
} from "@/domain/audit_timeline";
import { StatusBadge, type BadgeTone } from "./StatusBadge";
import { use_workspace } from "./WorkspaceProvider";

const OUTCOME_TONES: Readonly<Record<string, BadgeTone>> = {
  succeeded: "positive", denied: "critical", failed: "warning",
};

/**
 * Render the append-only, redacted audit timeline.
 *
 * @returns The audit timeline region.
 */
export function AuditTimeline(): ReactElement {
  const workspace = use_workspace();
  const status_ref = useRef<HTMLParagraphElement>(null);
  const announced = useRef<readonly string[]>([]);
  const [new_count, set_new_count] = useState(0);
  const entries = workspace.snapshot.audit_entries;

  useEffect(() => {
    const added = count_new_entries(announced.current, workspace.audit_entry_ids);
    announced.current = workspace.audit_entry_ids;
    if (added > 0) {
      set_new_count(added);
      status_ref.current?.focus();
    }
  }, [workspace.audit_entry_ids]);

  return (
    <section className="panel" aria-labelledby="audit-heading">
      <h2 id="audit-heading">Audit timeline</h2>
      <p className="result-count" role="status" tabIndex={-1} ref={status_ref}>
        {entries.length} audit entries. {new_count} added in this session.
      </p>
      <p className="panel__note">
        Projected fields only: actor, action, target, outcome, reason code, and request id. Submitted free-text
        reasons are never stored locally and never rendered.
      </p>
      {entries.length === 0
        ? <p>No operator actions have been attempted in this session.</p>
        : <ol className="timeline">{entries.map((entry) => <AuditItem key={entry.entry_id} entry={entry} />)}</ol>}
    </section>
  );
}

interface AuditItemProps {
  entry: AuditEntry;
}

function AuditItem(props: AuditItemProps): ReactElement {
  const entry = props.entry;
  return (
    <li className="timeline__item">
      <time dateTime={entry.at_iso}>{entry.at_iso}</time>
      <span className="timeline__action">{entry.action}</span>
      <StatusBadge
        label={audit_outcome_label(entry.outcome)}
        tone={OUTCOME_TONES[entry.outcome] ?? "neutral"}
        status={entry.outcome}
      />
      <dl className="card__facts">
        <div key="actor"><dt>Actor</dt><dd>{entry.actor_subject}</dd></div>
        <div key="target"><dt>Target</dt><dd>{entry.target_id}</dd></div>
        <div key="reason_code"><dt>Reason code</dt><dd>{entry.reason_code ?? "none"}</dd></div>
        <div key="request"><dt>Request</dt><dd>{entry.request_id}</dd></div>
      </dl>
    </li>
  );
}