import type { ReactElement } from "react";
import { OperatorActionPanel } from "@/components/OperatorActionPanel";
import { PageHeader } from "@/components/PageHeader";
import { load_workspace_scope } from "../local_scope";
import { require_session_principal } from "../auth/session";

/**
 * Render the audited operator action surface.
 *
 * @returns The actions page.
 */
export default async function ActionsPage(): Promise<ReactElement> {
  const { snapshot } = load_workspace_scope(await require_session_principal());
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