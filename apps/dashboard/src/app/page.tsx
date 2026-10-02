import type { ReactElement } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { count_breached_items } from "@/domain/operator_queue_board";
import { count_open_conflicts } from "@/domain/conflict_board";
import { get_health } from "@/index";
import { load_local_scope, type LocalScope } from "./local_scope";

interface Stat {
  value: number;
  label: string;
}

interface ViewLink {
  href: string;
  title: string;
  description: string;
}

const VIEW_LINKS: readonly ViewLink[] = [
  { href: "/appointments", title: "Appointments", description: "Sortable, filterable, tenant-scoped list." },
  { href: "/conflicts", title: "Conflicts", description: "Pending, proposed, accepted, rejected, expired." },
  { href: "/queue", title: "Queue", description: "Assignment, escalation, SLA timers." },
  { href: "/actions", title: "Actions", description: "Audited operator action surface." },
  { href: "/audit", title: "Audit", description: "Redacted, PII-minimised timeline." },
];

/**
 * Render the operator workspace overview.
 *
 * @returns The overview page.
 */
export default function OverviewPage(): ReactElement {
  const scope = load_local_scope();
  const health = get_health();
  const stats = overview_stats(scope);

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Operator workspace"
        description={<>Local build health: <strong data-health-app={health.app}>{health.ok ? "ok" : "failed"}</strong>. All figures below come from synthetic fixtures scoped to tenant <strong>{scope.tenant_id}</strong> with the <strong>{scope.role}</strong> role.</>}
      />
      <section className="panel" aria-labelledby="overview-heading">
        <h2 id="overview-heading">Current state</h2>
        <dl className="stat-grid">
          {stats.map((stat) => (
            <div className="stat" key={stat.label}>
              <dt className="stat__label">{stat.label}</dt>
              <dd className="stat__value">{stat.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="panel" aria-labelledby="views-heading">
        <h2 id="views-heading">Views</h2>
        <nav className="nav-grid" aria-label="Workspace views">
          {VIEW_LINKS.map((view) => (
            <Link className="nav-card" href={view.href} key={view.href}>
              <span className="nav-card__title">{view.title}</span>
              <span className="nav-card__description">{view.description}</span>
            </Link>
          ))}
        </nav>
      </section>
    </>
  );
}

/**
 * Count the figures the overview tiles display.
 *
 * The breached count is measured against the snapshot's own instant rather than
 * a fresh clock reading, so the tile cannot disagree with the queue board.
 *
 * @param scope - The request's resolved local scope.
 * @returns One labelled count per tile, in display order.
 */
function overview_stats(scope: LocalScope): readonly Stat[] {
  const snapshot = scope.snapshot;
  const now = new Date(Date.parse(snapshot.now_iso));
  return [
    { value: snapshot.appointments.length, label: "Appointments visible" },
    { value: snapshot.hidden_by_tenant_scope, label: "Hidden by tenant scope" },
    { value: count_open_conflicts(snapshot.conflicts), label: "Conflicts awaiting a decision" },
    { value: count_breached_items(snapshot.queue_items, now), label: "Queue items past SLA" },
    { value: snapshot.audit_entries.length, label: "Audit entries this session" },
  ];
}