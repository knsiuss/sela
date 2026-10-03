import type { ReactElement } from "react";
import { AppointmentTable } from "@/components/AppointmentTable";
import { PageHeader } from "@/components/PageHeader";
import { load_workspace_scope } from "../local_scope";

/**
 * Render the tenant-scoped appointment list.
 *
 * @returns The appointments page.
 */
export default async function AppointmentsPage(): Promise<ReactElement> {
  const { snapshot } = await load_workspace_scope();
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Appointments"
        description={<>Tenant-scoped list. Sorting and filtering happen over identifiers only; no customer name, phone number, or message content is stored or rendered in this workspace. All timestamps are UTC.</>}
      />
      <AppointmentTable rows={snapshot.appointments} tenant_id={snapshot.tenant_id} />
    </>
  );
}
