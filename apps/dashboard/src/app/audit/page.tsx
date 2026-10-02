import type { ReactElement } from "react";
import { AuditTimeline } from "@/components/AuditTimeline";
import { load_local_scope } from "../local_scope";

/**
 * Render the redacted operator audit timeline.
 *
 * @returns The audit page.
 */
export default function AuditPage(): ReactElement {
  const { snapshot } = load_local_scope();
  return (
    <>
      <h1>Audit</h1>
      <p>
        Tenant-scoped to <strong>{snapshot.tenant_id}</strong>. Entries carry operator, action, target,
        outcome, reason code, and request id only.
      </p>
      <AuditTimeline />
    </>
  );
}