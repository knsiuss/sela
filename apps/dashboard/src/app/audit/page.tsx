import type { ReactElement } from "react";
import { AuditTimeline } from "@/components/AuditTimeline";
import { PageHeader } from "@/components/PageHeader";
import { load_workspace_scope } from "../local_scope";

/**
 * Render the redacted operator audit timeline.
 *
 * @returns The audit page.
 */
export default async function AuditPage(): Promise<ReactElement> {
  const { snapshot } = await load_workspace_scope();
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Audit"
        description={<>Tenant-scoped to <strong>{snapshot.tenant_id}</strong>. Entries carry operator, action, target, outcome, reason code, and request id only. All timestamps are UTC.</>}
      />
      <AuditTimeline />
    </>
  );
}
