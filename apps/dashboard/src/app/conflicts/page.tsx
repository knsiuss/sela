import type { ReactElement } from "react";
import { ConflictBoard } from "@/components/ConflictBoard";
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
      <h1>Conflicts</h1>
      <p>
        Lifecycle: pending, proposed, then one terminal state of accepted, rejected, or expired.
        Accepting a resolution requires MFA claims, and a stale generation is rejected by the domain.
      </p>
      <ConflictBoard tenant_id={snapshot.tenant_id} />
    </>
  );
}