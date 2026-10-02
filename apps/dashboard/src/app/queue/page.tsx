import type { ReactElement } from "react";
import { PageHeader } from "@/components/PageHeader";
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
      <PageHeader
        eyebrow="Workspace"
        title="Operator queue"
        description={<>Workflow: unassigned, assigned, escalated, then resolved. Escalation stops at the domain cap, and SLA urgency is computed from the queue contract rather than restated here. All timestamps are UTC.</>}
      />
      <QueueBoard tenant_id={snapshot.tenant_id} />
    </>
  );
}