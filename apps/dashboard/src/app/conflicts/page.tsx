import type { ReactElement } from "react";
import { ConflictBoard } from "@/components/ConflictBoard";
import { PageHeader } from "@/components/PageHeader";
import { load_local_scope } from "../local_scope";

/**
 * Render the conflict resolution state UI.
 *
 * @returns The conflicts page.
 */
export default function ConflictsPage(): ReactElement {
  const { snapshot } = load_local_scope();
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