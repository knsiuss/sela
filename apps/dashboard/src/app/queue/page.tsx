import type { ReactElement } from "react";
import { PageHeader } from "@/components/PageHeader";
import { QueueBoard } from "@/components/QueueBoard";
import { load_workspace_scope } from "../local_scope";
import { require_session_principal } from "../auth/session";

/**
 * Render the assignment, escalation, and SLA workflow.
 *
 * @returns The queue page.
 */
export default async function QueuePage(): Promise<ReactElement> {
  const { snapshot } = load_workspace_scope(await require_session_principal());
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