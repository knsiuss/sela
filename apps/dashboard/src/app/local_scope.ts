/**
 * Shared server helpers for the operator dashboard pages.
 *
 * One module owns "what is this process scoped to", so no page can invent its
 * own tenant or role and no browser input can influence either value.
 *
 * The reference time is read exactly once per request. `load_local_scope` used
 * to be called by the root layout and again by every page, so a single request
 * took two `Date.now()` readings and the shell snapshot could differ from the
 * page snapshot by a millisecond. Reading the clock is now split from resolving
 * the scope, and the reading is wrapped in React's per-request `cache`, so one
 * request shares one identical scope object.
 */

import { cache } from "react";
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
 * Resolve the local scope from an explicit reference time.
 *
 * The same reading feeds both the synthetic fixture clock and the snapshot, so
 * the two can never describe different moments.
 *
 * @param now_ms - Reference epoch milliseconds for this resolution.
 * @returns Tenant, role, synthetic claims, and a fresh synthetic snapshot.
 * @throws When the configured tenant or role is malformed.
 */
export function resolve_local_scope(now_ms: number): LocalScope {
  const tenant_id = resolve_local_tenant_id(process.env);
  const role = resolve_local_role(process.env);
  const fixture = create_workspace_fixture(now_ms);
  return {
    tenant_id,
    role,
    principal: to_wire_principal(build_local_principal(tenant_id, role)),
    snapshot: create_workspace_snapshot(fixture, tenant_id, now_ms),
  };
}

/**
 * Resolve the local scope once per request.
 *
 * React's `cache` is request-scoped under the App Router, so the root layout
 * and every page in the same request receive the same object and therefore the
 * same `Date.now()` reading.
 *
 * @returns The request's local scope.
 * @throws When the configured tenant or role is malformed.
 */
export const load_local_scope = cache((): LocalScope => resolve_local_scope(Date.now()));