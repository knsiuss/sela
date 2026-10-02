import type { ReactElement } from "react";
import { AppointmentTable } from "@/components/AppointmentTable";
import { load_local_scope } from "../local_scope";

/**
 * Render the tenant-scoped appointment list.
 *
 * @returns The appointments page.
 */
export default function AppointmentsPage(): ReactElement {
  const { snapshot } = load_local_scope();
  return (
    <>
      <h1>Appointments</h1>
      <p>
        Tenant-scoped list. Sorting and filtering happen over identifiers only; no customer name,
        phone number, or message content is stored or rendered in this workspace.
      </p>
      <AppointmentTable rows={snapshot.appointments} tenant_id={snapshot.tenant_id} />
    </>
  );
}