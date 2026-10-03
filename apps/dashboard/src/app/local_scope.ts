/**
 * Request scope for the operator workspace, resolved from the real session.
 *
 * The previous version of this module resolved a synthetic principal and hard-coded
 * `has_mfa: true`, which meant every privileged action passed the MFA gate with no
 * second factor anywhere in the system. It is replaced rather than extended:
 *
 * - The tenant and role now come from a session-backed principal, so the browser
 *   cannot widen its own scope by editing a query string.
 * - MFA is whatever the identity provider asserted. Unverified MFA is `false`,
 *   so privileged actions fail closed.
 * - With no IdP configured, or no session, `load_workspace_scope` throws. The
 *   layout turns that into a refusal, so local development never falls back to an
 *   unauthenticated dashboard.
 *
 * The reference time is still read exactly once per request and shared through
 * React's `cache`. `load_workspace_scope` takes no arguments on purpose:
 * `cache` compares its arguments, and every caller used to pass a freshly built
 * principal object, so the comparison never matched and the "one instant per
 * request" the comment claims did not hold. Resolving the session inside a
 * zero-argument wrapper makes the cache key constant and therefore a hit.
 */

import { cache } from "react";
import { OAuthFlowError } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import type { AuthenticatedPrincipal, EnterpriseRole } from "appointment-agent/dist/src/enterprise/authorization.js";
import { create_workspace_fixture } from "@/domain/fixtures";
import type { PrincipalClaims } from "@/domain/principal_claims";
import { to_wire_principal } from "@/domain/principal_claims";
import type { WorkspaceSnapshot } from "@/domain/workspace_state";
import { create_workspace_snapshot } from "@/domain/workspace_state";
import { require_session_principal } from "./auth/session";

/** Everything the server components need for one authenticated request. */
export interface WorkspaceScope {
  tenant_id: string;
  role: EnterpriseRole;
  principal: PrincipalClaims;
  snapshot: WorkspaceSnapshot;
}

/** Privilege order used to pick the role shown for capability hints. */
const ROLE_PRECEDENCE: readonly EnterpriseRole[] = [
  "owner", "admin", "developer", "operator", "support", "analyst",
];

/**
 * Build the request scope from an authenticated principal.
 *
 * @param now_ms - Reference epoch milliseconds for this resolution.
 * @param principal - Principal resolved from the verified session cookie.
 * @returns Tenant, role, verified claims, and a fresh synthetic snapshot.
 * @throws OAuthFlowError when the principal has no tenant membership.
 */
export function resolve_workspace_scope(now_ms: number, principal: AuthenticatedPrincipal): WorkspaceScope {
  const tenant_id = workspace_tenant(principal);
  const role = workspace_role(principal, tenant_id);
  const fixture = create_workspace_fixture(now_ms);
  return {
    tenant_id,
    role,
    principal: to_wire_principal(principal),
    snapshot: create_workspace_snapshot(fixture, tenant_id, now_ms),
  };
}

/**
 * Resolve the request scope once per request.
 *
 * React's `cache` is request-scoped under the App Router, so the root layout and
 * every page in the same request receive the same object and therefore the same
 * `Date.now()` reading. The signature is empty on purpose: an argument would
 * become the cache key, and the principal every caller can supply is a fresh
 * object, so the key would never match.
 *
 * @returns The request's workspace scope.
 * @throws OAuthFlowError when the request has no usable session, or when the
 * principal has no tenant membership.
 */
export const load_workspace_scope = cache(async (): Promise<WorkspaceScope> => {
  return resolve_workspace_scope(Date.now(), await require_session_principal());
});

/**
 * Lowest tenant id a principal may act in; deterministic workspace scope.
 *
 * @param principal - Session-backed principal.
 * @returns One tenant id from the principal's memberships.
 * @throws OAuthFlowError when the principal has no membership.
 */
export function workspace_tenant(principal: AuthenticatedPrincipal): string {
  const first = Object.keys(principal.tenant_roles).sort()[0];
  if (first === undefined) throw new OAuthFlowError("oauth_membership_unresolved");
  return first;
}

/**
 * Highest-privilege role a principal holds in a tenant, for UI hints only.
 *
 * This is a display hint. Every actual decision goes through
 * `authorize` / `authorize_privileged` on the server.
 *
 * @param principal - Session-backed principal.
 * @param tenant_id - Tenant the workspace is scoped to.
 * @returns The most privileged role held there.
 * @throws OAuthFlowError when the principal holds no role in that tenant.
 */
export function workspace_role(principal: AuthenticatedPrincipal, tenant_id: string): EnterpriseRole {
  const roles = principal.tenant_roles[tenant_id] ?? [];
  for (const candidate of ROLE_PRECEDENCE) {
    if (roles.includes(candidate)) return candidate;
  }
  throw new OAuthFlowError("oauth_membership_unresolved");
}
