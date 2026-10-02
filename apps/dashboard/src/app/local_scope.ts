/**
 * Shared server helpers for the operator dashboard pages.
 *
 * One module owns "what is this process scoped to", so no page can invent its
 * own tenant or role and no browser input can influence either value.
 */

import type { EnterpriseRole } from "appointment-agent/dist/src/enterprise/authorization.js";
import { create_workspace_fixture } from "@/domain/fixtures";
import {
  build_local_principal,
  resolve_local_role,
  resolve_local_tenant_id,
  to_wire_principal,
  type LocalPrincipalClaims,
} from "@/domain/synthetic_principal";
import type { WorkspaceSnapshot } from "@/domain/workspace_state";
import { create_workspace_snapshot } from "@/domain/workspace_state";

/** Everything the server components need about the local scope. */
export interface LocalScope {
  tenant_id: string;
  role: EnterpriseRole;
  principal: LocalPrincipalClaims;
  snapshot: WorkspaceSnapshot;
}

/**
 * Resolve the local scope and build the initial snapshot for a page render.
 *
 * @returns Tenant, role, synthetic claims, and a fresh synthetic snapshot.
 * @throws LocalScopeError When the configured tenant or role is malformed.
 */
export function load_local_scope(): LocalScope {
  const tenant_id = resolve_local_tenant_id(process.env);
  const role = resolve_local_role(process.env);
  const now_ms = Date.now();
  const fixture = create_workspace_fixture(now_ms);
  return {
    tenant_id,
    role,
    principal: to_wire_principal(build_local_principal(tenant_id, role)),
    snapshot: create_workspace_snapshot(fixture, tenant_id, now_ms),
  };
}