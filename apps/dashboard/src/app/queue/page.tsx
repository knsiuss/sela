import type { ReactElement } from "react";
import { QueueBoard } from "@/components/QueueBoard";
import { load_local_scope } from "../local_scope";

/**
 * Render the assignment, escalation, and SLA workflow.
 *
 * @returns The queue page.
 */
export default function QueuePage(): ReactElement {
  const { snapshot } = load_local_scope();
  return (
    <>
      <h1>Operator queue</h1>
      <p>
        Workflow: unassigned, assigned, escalated, then resolved. Escalation stops at the domain cap,
        and SLA urgency is computed from the queue contract rather than restated here.
      </p>
      <QueueBoard tenant_id={snapshot.tenant_id} />
    </>
  );
}