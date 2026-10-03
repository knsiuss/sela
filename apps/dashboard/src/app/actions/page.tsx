import type { ReactElement } from "react";
import { OperatorActionPanel } from "@/components/OperatorActionPanel";
import { PageHeader } from "@/components/PageHeader";
import { load_workspace_scope } from "../local_scope";

/**
 * Render the audited operator action surface.
 *
 * @returns The actions page.
 */
export default async function ActionsPage(): Promise<ReactElement> {
  const { snapshot } = await load_workspace_scope();
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Operator actions"
        description={<>Every attempt is authorized by the enterprise action contract and appended to an append-only audit ledger, whether it succeeds, is denied, or fails.</>}
      />
      <OperatorActionPanel tenant_id={snapshot.tenant_id} />
    </>
  );
}
