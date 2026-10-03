import type { ReactElement } from "react";
import { ConflictBoard } from "@/components/ConflictBoard";
import { PageHeader } from "@/components/PageHeader";
import { load_workspace_scope } from "../local_scope";
import { require_session_principal } from "../auth/session";

/**
 * Render the conflict resolution state UI.
 *
 * @returns The conflicts page.
 */
export default async function ConflictsPage(): Promise<ReactElement> {
  const { snapshot } = load_workspace_scope(await require_session_principal());
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Conflicts"
        description={<>Lifecycle: pending, proposed, then one terminal state of accepted, rejected, or expired. Accepting a resolution requires MFA claims, and a stale generation is rejected by the domain. All timestamps are UTC.</>}
      />
      <ConflictBoard tenant_id={snapshot.tenant_id} />
    </>
  );
}