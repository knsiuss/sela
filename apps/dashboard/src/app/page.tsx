import type { ReactElement } from "react";
import { count_breached_items } from "@/domain/operator_queue_board";
import { count_open_conflicts } from "@/domain/conflict_board";
import { get_health } from "@/index";
import { load_local_scope } from "./local_scope";

/**
 * Render the operator workspace overview.
 *
 * @returns The overview page.
 */
export default function OverviewPage(): ReactElement {
  const scope = load_local_scope();
  const { snapshot } = scope;
  const open_conflicts = count_open_conflicts(snapshot.conflicts);
  const breached = count_breached_items(snapshot.queue_items, new Date(Date.parse(snapshot.now_iso)));
  const health = get_health();

  return (
    <>
      <h1>Operator workspace</h1>
      <p>
        Local build health: <strong data-health-app={health.app}>{health.ok ? "ok" : "failed"}</strong>.
        All figures below come from synthetic fixtures scoped to tenant{" "}
        <strong>{scope.tenant_id}</strong> with the <strong>{scope.role}</strong> role.
      </p>
      <section className="panel" aria-labelledby="overview-heading">
        <h2 id="overview-heading">Current state</h2>
        <ul className="summary-list">
          <li>{snapshot.appointments.length} appointments visible in this tenant.</li>
          <li>{snapshot.hidden_by_tenant_scope} appointment rows hidden by tenant scoping.</li>
          <li>{open_conflicts} conflicts awaiting an operator decision.</li>
          <li>{breached} queue items past their SLA deadline.</li>
          <li>{snapshot.audit_entries.length} audit entries recorded this session.</li>
        </ul>
      </section>
      <section className="panel" aria-labelledby="views-heading">
        <h2 id="views-heading">Views</h2>
        <ul className="summary-list">
          <li><a href="/appointments">Appointments</a>: sortable, filterable, tenant-scoped list.</li>
          <li><a href="/conflicts">Conflicts</a>: pending, proposed, accepted, rejected, expired.</li>
          <li><a href="/queue">Queue</a>: assignment, escalation, SLA timers.</li>
          <li><a href="/actions">Actions</a>: audited operator action surface.</li>
          <li><a href="/audit">Audit</a>: redacted, PII-minimized timeline.</li>
        </ul>
      </section>
    </>
  );
}